import os
import json
import time
import threading
import paho.mqtt.client as mqtt_client
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# MQTT Configuration
MQTT_BROKER = "broker.hivemq.com"
MQTT_PORT = 1883
TOPIC_DATA_SUB = "node/+/data"
TOPIC_STATUS_SUB = "node/+/status"
TOPIC_CALIBRATION_PUB = "node/NODE001/calibration" # Assuming singular dashboard for NODE001 for now

CALIBRATION_FILE = os.path.join(os.path.dirname(__file__), "calibration.json")
TELEMETRY_FILE   = os.path.join(os.path.dirname(__file__), "telemetry.json")
ACK_FILE         = os.path.join(os.path.dirname(__file__), "ack.json")

DEFAULT_CALIBRATION = {
    "version":      0,
    "co_gain":      1.0,  "co_offset":    0.0,
    "o3_gain":      1.0,  "o3_offset":    0.0,
    "co2_gain":     1.0,  "co2_offset":   0.0,
    "pm25_gain":    1.0,  "pm25_offset":  0.0,
    "temp_offset":  0.0,  "hum_offset":   0.0
}

def load_json(filepath, default):
    if os.path.exists(filepath):
        try:
            with open(filepath) as f:
                return json.load(f)
        except Exception:
            pass
    return default

def save_json(filepath, data):
    try:
        with open(filepath, "w") as f:
            json.dump(data, f, indent=4)
        return True
    except Exception:
        return False

def load_calibration(): return load_json(CALIBRATION_FILE, dict(DEFAULT_CALIBRATION))
def save_calibration(data): return save_json(CALIBRATION_FILE, data)

def load_ack(): return load_json(ACK_FILE, {"acknowledged_version": 0, "ack_time": None})
def save_ack(version):
    save_json(ACK_FILE, {
        "acknowledged_version": version,
        "ack_time": time.strftime("%Y-%m-%d %H:%M:%S")
    })

# ── MQTT Client Setup ─────────────────────────────────────────────────────

mqttc = mqtt_client.Client(mqtt_client.CallbackAPIVersion.VERSION2)

def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Connected to MQTT broker with result code {reason_code}")
    client.subscribe(TOPIC_DATA_SUB)
    client.subscribe(TOPIC_STATUS_SUB)

def on_message(client, userdata, msg):
    payload = msg.payload.decode('utf-8')
    try:
        data = json.loads(payload)
        
        # Telemetry Data
        if msg.topic.endswith("/data"):
            data["timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S")
            save_json(TELEMETRY_FILE, data)
            
            # Fallback ACK check (if status msg missed)
            board_version = data.get("applied_cal_version", 0)
            cal = load_calibration()
            if board_version and board_version == cal.get("version", 0):
                save_ack(board_version)

        # Status / ACK Data
        elif msg.topic.endswith("/status"):
            if data.get("status") == "SUCCESS":
                version = data.get("version", 0)
                cal = load_calibration()
                if version and version == cal.get("version", 0):
                    save_ack(version)

    except json.JSONDecodeError:
        print(f"Failed to parse JSON from {msg.topic}")
    except Exception as e:
        print(f"Error handling message: {e}")

mqttc.on_connect = on_connect
mqttc.on_message = on_message

def start_mqtt():
    try:
        mqttc.connect(MQTT_BROKER, MQTT_PORT, 60)
        mqttc.loop_start()
    except Exception as e:
        print(f"Failed to start MQTT: {e}")

# ── Routes ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/ports")
def list_ports():
    return jsonify({"ports": [{"port": "MQTT", "desc": "HiveMQ Wireless Downlink"}]})

# ── Dashboard upload ────────────────────────────────────────────────────────
@app.route("/api/send_calibration", methods=["POST"])
def send_calibration():
    data = request.json
    if not data:
        return jsonify({"success": False, "message": "No data provided"}), 400

    try:
        version = int(time.time())
        cal_data = {
            "version":      version,
            "co_gain":      float(data.get("co_gain",     1.0)),
            "co_offset":    float(data.get("co_offset",   0.0)),
            "o3_gain":      float(data.get("o3_gain",     1.0)),
            "o3_offset":    float(data.get("o3_offset",   0.0)),
            "co2_gain":     float(data.get("co2_gain",    1.0)),
            "co2_offset":   float(data.get("co2_offset",  0.0)),
            "pm25_gain":    float(data.get("pm25_gain",   1.0)),
            "pm25_offset":  float(data.get("pm25_offset", 0.0)),
            "temp_offset":  float(data.get("temp_offset", 0.0)),
            "hum_offset":   float(data.get("hum_offset",  0.0))
        }
    except (ValueError, TypeError) as e:
        return jsonify({"success": False, "message": f"Invalid values: {e}"}), 400

    if save_calibration(cal_data):
        # Publish to MQTT instantly
        # Publish to MQTT with retain=True so board gets it instantly on reconnect
        mqttc.publish(TOPIC_CALIBRATION_PUB, json.dumps(cal_data), qos=1, retain=True)
        
        return jsonify({
            "success": True,
            "version": version,
            "message": "Calibration published via MQTT. Board should apply instantly.",
            "log": [f"Saved to server (v{version}).", "MQTT Publish sent. Waiting for board ACK..."]
        })
    return jsonify({"success": False, "message": "Failed to save on server."}), 500

# Legacy endpoints included so Arduino doesn't crash if it hasn't been updated yet
@app.route("/api/v1/calibration")
def get_calibration():
    return jsonify(load_calibration())

@app.route("/api/v1/data/ingest", methods=["POST"])
def ingest_data():
    return jsonify({"status": "success", "message": "Migrated to MQTT"})

# ── Dashboard status poll ───────────────────────────────────────────────────
@app.route("/api/status")
def get_status():
    cal      = load_calibration()
    ack      = load_ack()
    telemetry = load_json(TELEMETRY_FILE, None)

    return jsonify({
        "calibration":          cal,
        "acknowledged_version": ack["acknowledged_version"],
        "ack_time":             ack.get("ack_time"),
        "telemetry":            telemetry
    })

if __name__ == "__main__":
    start_mqtt()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False) # Reloader turned off to avoid duplicate MQTT clients
