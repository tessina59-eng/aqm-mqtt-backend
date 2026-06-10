document.addEventListener('DOMContentLoaded', () => {
    const calibrationForm  = document.getElementById('calibration-form');
    const submitBtn        = document.getElementById('submit-btn');
    const resetDefaultsBtn = document.getElementById('reset-defaults-btn');
    const spinner          = submitBtn.querySelector('.spinner');
    const btnText          = submitBtn.querySelector('.btn-text');
    const consoleOutput    = document.getElementById('console-output');
    const toast            = document.getElementById('toast');
    const toastMessage     = document.getElementById('toast-message');

    const telPm25    = document.getElementById('tel-pm25');
    const telCo2     = document.getElementById('tel-co2');
    const telCo      = document.getElementById('tel-co');
    const telO3      = document.getElementById('tel-o3');
    const telTemp    = document.getElementById('tel-temp');
    const telHum     = document.getElementById('tel-hum');
    const gsmStatus  = document.getElementById('gsm-status');
    const gsmLastSeen = document.getElementById('gsm-last-seen');

    const defaults = {
        co_gain: "1.000", co_offset: "0.00",
        o3_gain: "1.000", o3_offset: "0.00",
        co2_gain: "1.000", co2_offset: "0.0",
        pm25_gain: "1.000", pm25_offset: "0.0",
        temp_offset: "0.0", hum_offset: "0.0"
    };

    let lastTelemetryTimestamp = null;
    let pendingVersion     = null;   // version queued, awaiting ACK
    let pendingUploadTime  = null;   // ms when upload was submitted
    let elapsedInterval    = null;   // setInterval for live timer
    let pendingLogLine     = null;   // DOM element to update live

    // ── Utilities ──────────────────────────────────────────────────────────

    function ts() { return new Date().toLocaleTimeString(); }

    function addLog(sender, html, cls = '') {
        const div = document.createElement('div');
        div.className = `log-line ${cls}`;
        div.innerHTML = `<span style="color:#8a8f9f">[${ts()}]</span> <strong>${sender}:</strong> ${html}`;
        consoleOutput.appendChild(div);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
        return div;
    }

    function showToast(msg, type = 'success') {
        toastMessage.textContent = msg;
        toast.className = `toast show ${type}`;
        setTimeout(() => toast.classList.remove('show'), 5000);
    }

    // ── Elapsed timer shown in log ──────────────────────────────────────────

    function startElapsedTimer(logDiv) {
        clearInterval(elapsedInterval);
        elapsedInterval = setInterval(() => {
            if (!pendingVersion || !pendingUploadTime) return;
            const sec = Math.floor((Date.now() - pendingUploadTime) / 1000);
            logDiv.innerHTML =
                `<span style="color:#8a8f9f">[${ts()}]</span> ` +
                `<strong>⏳ Waiting for board ACK</strong> — ` +
                `<span style="color:var(--accent-blue)">${sec}s elapsed</span>`;
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }, 1000);
    }

    function confirmACK(sec, ackTime) {
        clearInterval(elapsedInterval);
        if (pendingLogLine) {
            pendingLogLine.innerHTML =
                `<span style="color:#8a8f9f">[${ts()}]</span> ` +
                `<strong style="color:var(--success-color)">✅ Board ACK received</strong> — ` +
                `applied in <strong>${sec}s</strong> (board confirmed at ${ackTime})`;
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }
        gsmStatus.textContent = '✅ Calibration applied & confirmed by board';
        showToast(`✅ Board confirmed calibration in ${sec}s!`, 'success');
        pendingVersion = null;
        pendingUploadTime = null;
        pendingLogLine = null;
    }

    // ── Reset form ──────────────────────────────────────────────────────────

    function resetToDefaults() {
        Object.keys(defaults).forEach(k => {
            const el = document.getElementById(k);
            if (el) el.value = defaults[k];
        });
        addLog('System', 'Form reset to defaults (Gains=1.0, Offsets=0.0).', 'system-msg');
        showToast('Form reset to defaults.', 'success');
    }

    // ── Status poll (every 3 s) ─────────────────────────────────────────────

    async function updateStatus() {
        try {
            const res  = await fetch('/api/status');
            const data = await res.json();

            // Pre-fill form on first load
            if (data.calibration && !calibrationForm.dataset.loaded) {
                Object.keys(data.calibration).forEach(k => {
                    const el = document.getElementById(k);
                    if (el) el.value = data.calibration[k];
                });
                calibrationForm.dataset.loaded = "true";
                addLog('Server', `Loaded active calibration (v${data.calibration.version || 0}).`, 'system-msg');
            }

            // ── Real ACK detection ──────────────────────────────────────
            if (pendingVersion && data.acknowledged_version === pendingVersion) {
                const sec = Math.floor((Date.now() - pendingUploadTime) / 1000);
                confirmACK(sec, data.ack_time || '—');
            }

            // ── Live telemetry ──────────────────────────────────────────
            if (data.telemetry) {
                const m = data.telemetry.metrics;
                if (m) {
                    telPm25.textContent = m.pm25       !== undefined ? m.pm25                  : '--';
                    telCo2.textContent  = m.co2        !== undefined ? m.co2                   : '--';
                    telCo.textContent   = m.co         !== undefined ? m.co.toFixed(2)         : '--';
                    telO3.textContent   = m.o3         !== undefined ? m.o3.toFixed(3)         : '--';
                    telTemp.textContent = m.temperature !== undefined ? m.temperature.toFixed(1): '--';
                    telHum.textContent  = m.humidity   !== undefined ? m.humidity.toFixed(0)   : '--';
                }
                if (data.telemetry.timestamp && data.telemetry.timestamp !== lastTelemetryTimestamp) {
                    lastTelemetryTimestamp = data.telemetry.timestamp;
                    gsmLastSeen.textContent = `Last contact: ${data.telemetry.timestamp}`;
                    gsmLastSeen.style.color = 'var(--success-color)';
                    addLog('Device', 'GSM telemetry received.', 'success');
                }
            }
        } catch (err) {
            console.error('Status poll error:', err);
        }
    }

    // ── Form submit ─────────────────────────────────────────────────────────

    calibrationForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const payload = {};
        Object.keys(defaults).forEach(k => {
            payload[k] = parseFloat(document.getElementById(k).value);
        });

        submitBtn.disabled       = true;
        resetDefaultsBtn.disabled = true;
        spinner.classList.remove('hidden');
        btnText.textContent      = 'Uploading...';

        addLog('Client', 'Saving calibration to server...', 'outgoing');

        try {
            const res    = await fetch('/api/send_calibration', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload)
            });
            const result = await res.json();

            if (result.success) {
                pendingVersion    = result.version;
                pendingUploadTime = Date.now();

                addLog('Server', `Queued — <strong>v${result.version}</strong>`, 'success');

                // Live-updating "waiting" line
                pendingLogLine = addLog('⏳ Waiting for board ACK', '0s elapsed', 'system-msg');
                startElapsedTimer(pendingLogLine);

                gsmStatus.textContent = '⏳ Calibration queued — waiting for board…';
                showToast('Calibration queued! Waiting for board confirmation.', 'success');
            } else {
                addLog('Error', result.message, 'error');
                showToast(result.message, 'error');
            }
        } catch (err) {
            addLog('System', `Request failed: ${err.message}`, 'error');
            showToast('Server communication failed.', 'error');
        } finally {
            submitBtn.disabled        = false;
            resetDefaultsBtn.disabled = false;
            spinner.classList.add('hidden');
            btnText.textContent       = 'Upload Calibration';
        }
    });

    resetDefaultsBtn.addEventListener('click', resetToDefaults);

    // ── Boot ────────────────────────────────────────────────────────────────
    addLog('System', 'Dashboard ready. Polling server every 3 seconds.', 'system-msg');
    updateStatus();
    setInterval(updateStatus, 3000);
});
