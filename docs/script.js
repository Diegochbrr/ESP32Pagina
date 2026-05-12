/* ═══════════════════════════════════════════════
   HEADCTRL DASHBOARD — script.js
   Serial (Web Serial API) + BLE (Web Bluetooth)
═══════════════════════════════════════════════ */

// ── Estado global ──────────────────────────────
const state = {
    connected: false,
    mode: null,          // 'serial' | 'bluetooth'
    sessionStart: null,
    totalCommands: 0,
    frameCount: 0,
    lastFpsTime: Date.now(),
    counts: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, IDLE: 0 },
    intensities: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 },
    pitch: 0,
    roll: 0,
    // Web Serial
    serialPort: null,
    serialReader: null,
    // Web Bluetooth
    bleDevice: null,
    bleServer: null,
};

// ── BLE UUIDs ──────────────────────────────────
const BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const BLE_NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// ── DOM refs ───────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
    statusPill: $('statusPill'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    themeToggle: $('themeToggle'),

    btnSerial: $('btnSerial'),
    btnBluetooth: $('btnBluetooth'),
    btnDisconnect: $('btnDisconnect'),
    btnReset: $('btnReset'),
    btnClearLog: $('btnClearLog'),

    serialPort: $('serialPort'),
    baudrate: $('baudrate'),
    bleName: $('bleName'),

    statTime: $('statTime'),
    statTotal: $('statTotal'),
    statFPS: $('statFPS'),
    statIntensity: $('statIntensity'),

    cntUp: $('cntUp'),
    cntDown: $('cntDown'),
    cntLeft: $('cntLeft'),
    cntRight: $('cntRight'),
    cntIdle: $('cntIdle'),

    barUp: $('barUp'),
    barDown: $('barDown'),
    barLeft: $('barLeft'),
    barRight: $('barRight'),
    barIdle: $('barIdle'),

    joystickDot: $('joystickDot'),
    joystickTrail: $('joystickTrail'),
    pitchVal: $('pitchVal'),
    rollVal: $('rollVal'),

    keyUp: $('keyUp'),
    keyDown: $('keyDown'),
    keyLeft: $('keyLeft'),
    keyRight: $('keyRight'),
    activeCombo: $('activeCombo'),

    intUp: $('intUp'),
    intDown: $('intDown'),
    intLeft: $('intLeft'),
    intRight: $('intRight'),
    pctUp: $('pctUp'),
    pctDown: $('pctDown'),
    pctLeft: $('pctLeft'),
    pctRight: $('pctRight'),

    logBody: $('logBody'),
    rawDisplay: $('rawDisplay'),


};

// ── Tema ───────────────────────────────────────
let darkMode = true;

els.themeToggle.addEventListener('click', () => {
    darkMode = !darkMode;
    document.body.classList.toggle('dark', darkMode);
    document.body.classList.toggle('light', !darkMode);
    els.themeToggle.textContent = darkMode ? '☽' : '☀';
});

// ── Tabs ───────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        $(`tab-${target}`).classList.add('active');
    });
});



// ── Log ────────────────────────────────────────
function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const t = new Date().toLocaleTimeString('es', { hour12: false });
    entry.textContent = `[${t}] ${msg}`;
    els.logBody.appendChild(entry);
    els.logBody.scrollTop = els.logBody.scrollHeight;
    // Limitar a 200 entradas
    while (els.logBody.children.length > 200) {
        els.logBody.removeChild(els.logBody.firstChild);
    }
}

els.btnClearLog.addEventListener('click', () => {
    els.logBody.innerHTML = '';
});

// ── Estado de conexión ─────────────────────────
function setConnected(mode) {
    state.connected = true;
    state.mode = mode;
    state.sessionStart = Date.now();
    els.statusPill.classList.add('connected');
    els.statusText.textContent = mode === 'serial' ? 'Serial' : 'Bluetooth';
    els.statusDot.style.background = '';
    els.btnSerial.classList.add('hidden');
    els.btnBluetooth.classList.add('hidden');
    els.btnDisconnect.classList.remove('hidden');
    log(`Conectado via ${mode}`, 'info');
}

function setDisconnected() {
    state.connected = false;
    state.mode = null;
    els.statusPill.classList.remove('connected');
    els.statusText.textContent = 'Desconectado';
    els.btnSerial.classList.remove('hidden');
    els.btnBluetooth.classList.remove('hidden');
    els.btnDisconnect.classList.add('hidden');
    resetKeys();
    log('Desconectado', 'error');
}

// ── Reset sesión ───────────────────────────────
function resetSession() {
    state.sessionStart = state.connected ? Date.now() : null;
    state.totalCommands = 0;
    state.frameCount = 0;
    state.counts = { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, IDLE: 0 };
    els.statTotal.textContent = '0';
    els.statFPS.textContent = '0';
    ['Up', 'Down', 'Left', 'Right', 'Idle'].forEach(d => {
        $(`cnt${d}`).textContent = '0';
        $(`bar${d}`).style.width = '0%';
    });
    log('Sesión reiniciada', 'info');
}

els.btnReset.addEventListener('click', resetSession);

// ── Parsear mensaje del ESP32 ─────────────────
// Formato extendido: "P:3.1,R:-12.8,UP:0.85,RIGHT:0.62"
// Formato legacy:    "UP:0.85,RIGHT:0.62" o "IDLE:0.000"
function parseMessage(raw) {
    raw = raw.trim();
    if (!raw) return;

    // Filtrar mensajes de boot/debug del ESP32
    if (/rst:|boot:|load:|entry|configsip|clk_drv|mode:DIO|Calibrando|giroscopio|posici/.test(raw)) return;

    els.rawDisplay.textContent = raw;
    state.totalCommands++;
    state.frameCount++;

    // Extraer pitch/roll — formato P:3.1,R:-12.8
    const pitchMatch = raw.match(/(?:^|,)P:([+-]?\d+\.?\d*)/);
    const rollMatch = raw.match(/(?:^|,)R:([+-]?\d+\.?\d*)/);
    if (pitchMatch) state.pitch = parseFloat(pitchMatch[1]);
    if (rollMatch) state.roll = parseFloat(rollMatch[1]);

    // Extraer acciones: UP, DOWN, LEFT, RIGHT, IDLE
    const actionPattern = /\b(UP|DOWN|LEFT|RIGHT|IDLE):(\d+\.?\d*)/g;
    const active = {};
    let match;
    while ((match = actionPattern.exec(raw)) !== null) {
        active[match[1]] = parseFloat(match[2]);
    }

    if (Object.keys(active).length === 0) return;

    // Si no vienen P/R en el mensaje, inferir posición desde acciones (formato viejo)
    if (!pitchMatch && !rollMatch) {
        const MAX = 28;
        const up = active['UP'] || 0;
        const down = active['DOWN'] || 0;
        const left = active['LEFT'] || 0;
        const right = active['RIGHT'] || 0;
        state.pitch = (up - down) * MAX;
        state.roll = (right - left) * MAX;
    }

    // Actualizar intensidades
    ['UP', 'DOWN', 'LEFT', 'RIGHT'].forEach(dir => {
        state.intensities[dir] = active[dir] || 0;
    });

    // Contar acciones
    Object.keys(active).forEach(dir => {
        if (active[dir] > 0.08 || dir === 'IDLE') {
            state.counts[dir] = (state.counts[dir] || 0) + 1;
        }
    });

    // Actualizar UI
    updateJoystick();
    updateKeys(active);
    updateIntensityBars();
    updateActionCounts();
    updateStats();

    const names = Object.keys(active).filter(d => d !== 'IDLE' && active[d] > 0.08);
    if (names.length > 0) log(`${names.join(' + ')} [${names.map(n => active[n].toFixed(2)).join(',')}]`, 'action');
}

// ── Joystick ───────────────────────────────────
function updateJoystick() {
    const MAX = 28; // grados máximos
    const SIZE = 80; // radio del joystick en px
    const cx = 100, cy = 100;

    const normRoll = Math.max(-1, Math.min(1, state.roll / MAX));
    const normPitch = Math.max(-1, Math.min(1, state.pitch / MAX));

    const x = cx + normRoll * SIZE;
    const y = cy - normPitch * SIZE;

    els.joystickDot.style.left = x + 'px';
    els.joystickDot.style.top = y + 'px';
    els.joystickTrail.style.left = x + 'px';
    els.joystickTrail.style.top = y + 'px';

    const ps = state.pitch >= 0 ? '+' : '';
    const rs = state.roll >= 0 ? '+' : '';
    els.pitchVal.textContent = `${ps}${state.pitch.toFixed(1)}°`;
    els.rollVal.textContent = `${rs}${state.roll.toFixed(1)}°`;
}

// ── Teclas ─────────────────────────────────────
function updateKeys(active) {
    const threshold = 0.08;
    const map = { UP: 'keyUp', DOWN: 'keyDown', LEFT: 'keyLeft', RIGHT: 'keyRight' };
    const names = [];

    Object.entries(map).forEach(([dir, id]) => {
        const on = (active[dir] || 0) > threshold;
        $(id).classList.toggle('active', on);
        if (on) names.push(dir);
    });

    if (names.length > 0) {
        els.activeCombo.textContent = names.join(' + ');
        els.activeCombo.classList.add('has-action');
    } else {
        els.activeCombo.textContent = 'IDLE';
        els.activeCombo.classList.remove('has-action');
    }
}

function resetKeys() {
    ['keyUp', 'keyDown', 'keyLeft', 'keyRight'].forEach(id => $(id).classList.remove('active'));
    els.activeCombo.textContent = 'IDLE';
    els.activeCombo.classList.remove('has-action');
    ['UP', 'DOWN', 'LEFT', 'RIGHT'].forEach(d => { state.intensities[d] = 0; });
    updateIntensityBars();
}

// ── Barras de intensidad ───────────────────────
function updateIntensityBars() {
    const dirs = ['Up', 'Down', 'Left', 'Right'];
    const keys = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    dirs.forEach((d, i) => {
        const pct = Math.round(state.intensities[keys[i]] * 100);
        $(`int${d}`).style.width = pct + '%';
        $(`pct${d}`).textContent = pct + '%';
    });
    // Intensidad promedio
    const avg = keys.reduce((s, k) => s + state.intensities[k], 0) / 4;
    els.statIntensity.textContent = avg.toFixed(2);
}

// ── Conteo de acciones ─────────────────────────
function updateActionCounts() {
    const dirs = ['Up', 'Down', 'Left', 'Right', 'Idle'];
    const keys = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'IDLE'];
    const max = Math.max(...keys.map(k => state.counts[k] || 0), 1);
    dirs.forEach((d, i) => {
        const count = state.counts[keys[i]] || 0;
        $(`cnt${d}`).textContent = count;
        $(`bar${d}`).style.width = ((count / max) * 100) + '%';
    });
}

// ── Stats ──────────────────────────────────────
function updateStats() {
    els.statTotal.textContent = state.totalCommands;
}

// Tiempo de sesión y FPS
setInterval(() => {
    if (state.sessionStart) {
        const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        els.statTime.textContent = `${h}:${m}:${s}`;
    }

    const now = Date.now();
    const fps = Math.round(state.frameCount / ((now - state.lastFpsTime) / 1000));
    els.statFPS.textContent = fps;
    state.frameCount = 0;
    state.lastFpsTime = now;
}, 1000);

// ═══════════════════════════════════════════════
// SERIAL (Web Serial API)
// ═══════════════════════════════════════════════
els.btnSerial.addEventListener('click', async () => {
    if (!('serial' in navigator)) {
        log('Web Serial no disponible. Usa Chrome 89+ con el flag activado.', 'error');
        alert('Web Serial API no disponible.\n\nPasos:\n1. Abre Chrome\n2. Ve a chrome://flags\n3. Activa "Experimental Web Platform features"\n4. Reinicia Chrome');
        return;
    }

    try {
        log('Solicitando puerto serial...', 'info');
        state.serialPort = await navigator.serial.requestPort();
        await state.serialPort.open({ baudRate: parseInt(els.baudrate.value) });
        setConnected('serial');
        readSerial();
    } catch (err) {
        log(`Error serial: ${err.message}`, 'error');
    }
});

async function readSerial() {
    const decoder = new TextDecoderStream();
    state.serialPort.readable.pipeTo(decoder.writable);
    state.serialReader = decoder.readable.getReader();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await state.serialReader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(line => parseMessage(line));
        }
    } catch (err) {
        log(`Serial interrumpido: ${err.message}`, 'error');
    } finally {
        setDisconnected();
        if (state.serialPort) {
            try { await state.serialPort.close(); } catch (_) { }
            state.serialPort = null;
        }
    }
}

// ═══════════════════════════════════════════════
// BLUETOOTH BLE (Web Bluetooth API)
// ═══════════════════════════════════════════════
els.btnBluetooth.addEventListener('click', async () => {
    if (!('bluetooth' in navigator)) {
        log('Web Bluetooth no disponible. Usa Chrome con HTTPS o localhost.', 'error');
        alert('Web Bluetooth API no disponible.\n\nRequisitos:\n- Chrome o Edge\n- HTTPS o localhost\n- Bluetooth del PC activado');
        return;
    }

    try {
        log(`Buscando "${els.bleName.value}"...`, 'info');
        state.bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: els.bleName.value }],
            optionalServices: [BLE_SERVICE_UUID]
        });

        state.bleDevice.addEventListener('gattserverdisconnected', onBLEDisconnect);

        log('Conectando a GATT...', 'info');
        state.bleServer = await state.bleDevice.gatt.connect();
        const service = await state.bleServer.getPrimaryService(BLE_SERVICE_UUID);
        const characteristic = await service.getCharacteristic(BLE_NOTIFY_UUID);
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', onBLEData);

        setConnected('bluetooth');
    } catch (err) {
        log(`Error BLE: ${err.message}`, 'error');
    }
});

function onBLEData(event) {
    const value = event.target.value;
    const text = new TextDecoder().decode(value);
    parseMessage(text);
}

function onBLEDisconnect() {
    log('BLE desconectado', 'error');
    setDisconnected();
}

// ── Desconectar ────────────────────────────────
els.btnDisconnect.addEventListener('click', async () => {
    if (state.mode === 'serial') {
        try {
            if (state.serialReader) await state.serialReader.cancel();
        } catch (_) { }
    } else if (state.mode === 'bluetooth') {
        try {
            if (state.bleDevice && state.bleDevice.gatt.connected) {
                state.bleDevice.gatt.disconnect();
            }
        } catch (_) { }
        setDisconnected();
    }
});

// ── Init ───────────────────────────────────────
log('Dashboard iniciado. Selecciona Serial o Bluetooth para conectar.', 'info');
log('Web Serial: requiere Chrome 89+ con flag experimental.', 'info');
log('Web Bluetooth: requiere Chrome + HTTPS o localhost.', 'info');

// ═══════════════════════════════════════════════
// BASE DE DATOS — Clever Cloud via Backend
// ═══════════════════════════════════════════════

const db = {
    url: () => $('dbUrl').value.trim().replace(/\/$/, ''),
    connected: false,
    sessionCount: 0,
};

// Acumuladores para calcular promedios al cerrar sesión
const sessionAccum = {
    intensitySum: 0,
    intensityCount: 0,
    fpsSum: 0,
    fpsCount: 0,
    dominantAction: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 },
};

function resetSessionAccum() {
    sessionAccum.intensitySum = 0;
    sessionAccum.intensityCount = 0;
    sessionAccum.fpsSum = 0;
    sessionAccum.fpsCount = 0;
    sessionAccum.dominantAction = { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 };
}

// Llamar cada vez que llega un frame para acumular datos
function accumulateFrame(active) {
    const dirs = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    let totalInt = 0;
    dirs.forEach(d => {
        const v = active[d] || 0;
        totalInt += v;
        if (v > 0.08) sessionAccum.dominantAction[d]++;
    });
    sessionAccum.intensitySum += totalInt / 4;
    sessionAccum.intensityCount++;
}

// ── Probar conexión con el backend ─────────────
async function testDbConnection() {
    const dot = $('dbDot');
    const status = $('dbStatus');
    dot.className = 'db-dot loading';
    status.textContent = 'Conectando...';

    try {
        const res = await fetch(`${db.url()}/ping`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.ok) {
            dot.className = 'db-dot ok';
            status.textContent = 'Conectado ✓';
            db.connected = true;
            loadStats();
            loadHistory();
        } else {
            throw new Error('Respuesta inesperada');
        }
    } catch (e) {
        dot.className = 'db-dot error';
        status.textContent = 'Sin conexión';
        db.connected = false;
    }
}

// ── Cargar estadísticas generales ─────────────
async function loadStats() {
    try {
        const res = await fetch(`${db.url()}/stats`);
        const data = await res.json();
        $('dbSessionCount').textContent = data.total_sesiones ?? '—';
        $('dbLastSession').textContent = data.ultima_sesion
            ? new Date(data.ultima_sesion).toLocaleString('es')
            : '—';
    } catch (_) { }
}

// ── Cargar historial de sesiones ───────────────
async function loadHistory() {
    try {
        const res = await fetch(`${db.url()}/sesiones?limit=10`);
        const sesiones = await res.json();
        const body = $('historyBody');

        if (!sesiones.length) {
            body.innerHTML = '<p class="history-empty">No hay sesiones registradas aún.</p>';
            return;
        }

        body.innerHTML = sesiones.map(s => {
            const fecha = new Date(s.fecha_inicio).toLocaleString('es');
            const dur = formatDuration(s.duracion_seg);
            const badgeModo = s.modo === 'serial'
                ? '<span class="history-badge badge-serial">Serial</span>'
                : '<span class="history-badge badge-ble">BLE</span>';
            return `
        <div class="history-item">
          <span class="history-date">${fecha}</span>
          <div class="history-detail">
            ${badgeModo}
            <span class="history-badge badge-time">⏱ ${dur}</span>
            <span class="history-badge badge-cmd">⌨ ${s.total_comandos}</span>
            <span class="history-badge badge-cmd">↑${s.cnt_up} ↓${s.cnt_down} ←${s.cnt_left} →${s.cnt_right}</span>
          </div>
        </div>`;
        }).join('');
    } catch (_) {
        $('historyBody').innerHTML = '<p class="history-empty">Error cargando historial.</p>';
    }
}

function formatDuration(secs) {
    if (!secs) return '0s';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ── Guardar sesión al desconectar ──────────────
async function saveSession() {
    if (!db.connected || !state.sessionStart) return;

    const duracion = Math.floor((Date.now() - state.sessionStart) / 1000);
    if (duracion < 5) return; // ignorar sesiones muy cortas

    const dominant = Object.entries(sessionAccum.dominantAction)
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'IDLE';

    const avgIntensity = sessionAccum.intensityCount > 0
        ? (sessionAccum.intensitySum / sessionAccum.intensityCount).toFixed(3)
        : 0;

    const payload = {
        fecha_inicio: new Date(state.sessionStart).toISOString(),
        fecha_fin: new Date().toISOString(),
        duracion_seg: duracion,
        modo: state.mode,
        total_comandos: state.totalCommands,
        cnt_up: state.counts.UP || 0,
        cnt_down: state.counts.DOWN || 0,
        cnt_left: state.counts.LEFT || 0,
        cnt_right: state.counts.RIGHT || 0,
        cnt_idle: state.counts.IDLE || 0,
        intensidad_avg: parseFloat(avgIntensity),
        accion_dominante: dominant,
    };

    try {
        await fetch(`${db.url()}/sesiones`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        log('Sesión guardada en la base de datos ✓', 'info');
        loadStats();
        loadHistory();
    } catch (e) {
        log('No se pudo guardar la sesión en BD', 'error');
    }
    resetSessionAccum();
}

// ── Hooks en eventos existentes ────────────────
// Acumular datos en cada frame
const _origParseMessage = parseMessage;  // no redefinible, mejor hook en updateStats
const _origUpdateStats = updateStats;
// Inyectar acumulación al parsear (override local)
const _origUpdateKeys = updateKeys;

// Hook: guardar sesión al desconectar
const _origSetDisconnected = setDisconnected;
window._hookedDisconnect = async () => {
    await saveSession();
    _origSetDisconnected();
};
els.btnDisconnect.removeEventListener('click', els.btnDisconnect._handler);
els.btnDisconnect.addEventListener('click', async () => {
    if (state.mode === 'serial') {
        try { if (state.serialReader) await state.serialReader.cancel(); } catch (_) { }
    } else if (state.mode === 'bluetooth') {
        try {
            if (state.bleDevice && state.bleDevice.gatt.connected)
                state.bleDevice.gatt.disconnect();
        } catch (_) { }
    }
    await saveSession();
    setDisconnected();
});

// ── Eventos UI ─────────────────────────────────
$('btnDbTest').addEventListener('click', testDbConnection);
$('btnRefreshHistory').addEventListener('click', () => {
    if (db.connected) { loadStats(); loadHistory(); }
    else testDbConnection();
});