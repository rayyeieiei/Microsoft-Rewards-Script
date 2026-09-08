import http from 'http'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { Database } from './Database'

export const logEmitter = new EventEmitter()

export interface AccountDashboardStatus {
    email: string
    status: string
    initialPoints: number
    collectedPoints: number
    desktopProgress: string
    mobileProgress: string
    bandwidth?: string
    error?: string
    lastUpdate: string
}

export interface AppOnlyManualRequiredEvent {
    type: 'app-only-manual-required'
    accountKey: string
    offerId: string
    title: string
    expectedPoints: number
    expiresAt?: string
    state: 'manual-required'
    detectedAt?: string
}

export interface DashboardState {
    currentIP: string
    proxyMode: boolean
    useDynamicWifiProxy: boolean
    useAdbIpRotation: boolean
    useGhostCursor: boolean
    isRunning: boolean
    startTime: number
    loadedAccounts: string[]
    accounts: Record<string, AccountDashboardStatus>
    manualQuests?: Record<string, AppOnlyManualRequiredEvent[]>
}

export let dashboardState: DashboardState = {
    currentIP: 'UNKNOWN_IP',
    proxyMode: false,
    useDynamicWifiProxy: false,
    useAdbIpRotation: true,
    useGhostCursor: true,
    isRunning: false,
    startTime: 0,
    loadedAccounts: [],
    accounts: {},
    manualQuests: {}
}

logEmitter.on('app-only-manual-required', (event: AppOnlyManualRequiredEvent) => {
    if (!dashboardState.manualQuests) {
        dashboardState.manualQuests = {}
    }
    const acc = event.accountKey || 'unknown'
    if (!dashboardState.manualQuests[acc]) {
        dashboardState.manualQuests[acc] = []
    }
    const existingIdx = dashboardState.manualQuests[acc].findIndex(q => q.offerId === event.offerId)
    const recordWithDate: AppOnlyManualRequiredEvent = {
        ...event,
        detectedAt: event.detectedAt || new Date().toLocaleTimeString()
    }
    if (existingIdx !== -1) {
        dashboardState.manualQuests[acc][existingIdx] = recordWithDate
    } else {
        dashboardState.manualQuests[acc].push(recordWithDate)
    }
})

export function updateDashboardAccount(email: string, update: Partial<AccountDashboardStatus>) {
    if (!dashboardState.accounts[email]) {
        dashboardState.accounts[email] = {
            email,
            status: 'Pending',
            initialPoints: 0,
            collectedPoints: 0,
            desktopProgress: '0/0',
            mobileProgress: '0/0',
            lastUpdate: new Date().toLocaleTimeString()
        }
    }
    dashboardState.accounts[email] = {
        ...dashboardState.accounts[email]!,
        ...update,
        lastUpdate: new Date().toLocaleTimeString()
    }
}

export function updateDashboardGlobal(update: Partial<Omit<DashboardState, 'accounts'>>) {
    dashboardState = {
        ...dashboardState,
        ...update
    }
}

export let onControlCommand: (cmd: { action: string; email?: string }) => Promise<void> = async () => {}

export function registerControlCallback(callback: (cmd: { action: string; email?: string }) => Promise<void>) {
    onControlCommand = callback
}

export let onConfigCommand: () => Promise<void> = async () => {}

export function registerConfigCallback(callback: () => Promise<void>) {
    onConfigCommand = callback
}

export let onIpConfirmCommand: () => void = () => {}

export function registerIpConfirmCallback(callback: () => void) {
    onIpConfirmCommand = callback
}

const htmlPage = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nexus C2 Rewards Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: 'Outfit', sans-serif;
            background-color: #0b0f19;
            color: #f1f5f9;
            padding: 2rem;
            min-height: 100vh;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid #1e293b;
            padding-bottom: 1rem;
        }
        h1 {
            font-size: 2rem;
            font-weight: 800;
            background: linear-gradient(135deg, #10b981, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .status-header {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        .pulse-dot {
            width: 10px;
            height: 10px;
            background-color: #10b981;
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 8px #10b981;
            animation: pulse 1.5s infinite;
        }
        .pulse-dot.idle {
            background-color: #f59e0b;
            box-shadow: 0 0 8px #f59e0b;
        }
        @keyframes pulse {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        
        .main-layout {
            display: grid;
            grid-template-columns: 1fr;
            gap: 2rem;
        }
        @media(min-width: 1024px) {
            .main-layout {
                grid-template-columns: 3fr 2fr;
            }
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .card {
            background-color: #111827;
            border: 1px solid #1f2937;
            border-radius: 12px;
            padding: 1.25rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s, border-color 0.2s;
        }
        .card:hover {
            transform: translateY(-2px);
            border-color: #3b82f6;
        }
        .card-label {
            font-size: 0.75rem;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 0.25rem;
        }
        .card-value {
            font-size: 1.25rem;
            font-weight: 600;
            color: #ffffff;
        }
        
        /* Control and Config Panels */
        .panel {
            background-color: #111827;
            border: 1px solid #1f2937;
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 2rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .panel-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 1.25rem;
            color: #ffffff;
            border-bottom: 1px solid #1f2937;
            padding-bottom: 0.5rem;
        }
        
        .btn-group {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            margin-bottom: 1rem;
        }
        button {
            font-family: 'Outfit', sans-serif;
            font-weight: 600;
            font-size: 0.875rem;
            padding: 0.6rem 1.2rem;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: background-color 0.15s, transform 0.1s;
        }
        button:active {
            transform: scale(0.98);
        }
        .btn-primary { background-color: #10b981; color: #ffffff; }
        .btn-primary:hover { background-color: #059669; }
        .btn-danger { background-color: #ef4444; color: #ffffff; }
        .btn-danger:hover { background-color: #dc2626; }
        .btn-secondary { background-color: #3b82f6; color: #ffffff; }
        .btn-secondary:hover { background-color: #2563eb; }
        
        .single-acc-form {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }
        .text-input {
            font-family: 'Outfit', sans-serif;
            background-color: #0b0f19;
            border: 1px solid #374151;
            border-radius: 8px;
            color: #f1f5f9;
            padding: 0.6rem 1rem;
            flex: 1;
            font-size: 0.875rem;
        }
        .text-input:focus {
            outline: none;
            border-color: #3b82f6;
        }

        /* Toggle Switches */
        .toggle-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }
        .toggle-item:last-child {
            margin-bottom: 0;
        }
        .switch {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
        }
        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #374151;
            transition: .3s;
            border-radius: 24px;
        }
        .slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 4px;
            bottom: 4px;
            background-color: white;
            transition: .3s;
            border-radius: 50%;
        }
        input:checked + .slider {
            background-color: #10b981;
        }
        input:checked + .slider:before {
            transform: translateX(24px);
        }

        /* Terminal Window */
        .terminal-container {
            background-color: #05070f;
            border: 1px solid #1f2937;
            border-radius: 12px;
            padding: 1rem;
            font-family: 'Fira Code', monospace;
            font-size: 0.825rem;
            height: 400px;
            overflow-y: auto;
            box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
            margin-top: 1rem;
        }
        #terminal {
            white-space: pre-wrap;
            word-break: break-all;
            color: #a7f3d0;
        }
        .log-line {
            margin-bottom: 0.25rem;
            line-height: 1.4;
        }

        /* Table CSS */
        .table-container {
            background-color: #111827;
            border: 1px solid #1f2937;
            border-radius: 12px;
            overflow-x: auto;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }
        th, td {
            padding: 0.875rem 1.25rem;
        }
        th {
            background-color: #1f2937;
            color: #94a3b8;
            font-weight: 600;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid #374151;
        }
        tr {
            border-bottom: 1px solid #1f2937;
            transition: background-color 0.15s;
        }
        tr:hover {
            background-color: #1f2937;
        }
        .status-badge {
            display: inline-block;
            padding: 0.2rem 0.6rem;
            border-radius: 9999px;
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-pending { background-color: #374151; color: #d1d5db; }
        .status-stealth { background-color: #1e3a8a; color: #93c5fd; }
        .status-login { background-color: #7c2d12; color: #ffedd5; }
        .status-running { background-color: #065f46; color: #a7f3d0; }
        .status-done { background-color: #065f46; color: #34d399; }
        .status-error { background-color: #991b1b; color: #fca5a5; }

        .highlight-green { color: #10b981; }
        .highlight-blue { color: #3b82f6; }
        .highlight-amber { color: #f59e0b; }
        .highlight-red { color: #ef4444; }
    </style>
</head>
<body>
    <header>
        <div>
            <h1>Nexus C2 Rewards Dashboard</h1>
        </div>
        <div class="status-header">
            <span id="active-pulse" class="pulse-dot idle"></span>
            <span id="active-status-text">C2 Standby</span>
        </div>
    </header>

    <div class="stats-grid">
        <div class="card">
            <div class="card-label">Total Accounts</div>
            <div id="stat-total-accounts" class="card-value">-</div>
        </div>
        <div class="card">
            <div class="card-label">Total Points Gained</div>
            <div id="stat-points-collected" class="card-value highlight-green">+0</div>
        </div>
        <div class="card">
            <div class="card-label">Active IP Address</div>
            <div id="stat-active-ip" class="card-value highlight-blue">-</div>
        </div>
        <div class="card">
            <div class="card-label">Total Runtime</div>
            <div id="stat-runtime" class="card-value highlight-amber">Idle</div>
        </div>
    </div>

    <div class="main-layout">
        <!-- Left Column: Accounts Table -->
        <div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Account</th>
                            <th>Status</th>
                            <th>Initial Points</th>
                            <th>Gained Points</th>
                            <th>Desktop Search</th>
                            <th>Mobile Search</th>
                            <th>Last Update</th>
                        </tr>
                    </thead>
                    <tbody id="accounts-table-body">
                        <tr>
                            <td colspan="7" style="text-align: center; color: #64748b;">Waiting for data...</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Terminal output window -->
            <div class="terminal-container">
                <div id="terminal"></div>
            </div>
        </div>

        <!-- Right Column: Control & Config Panels -->
        <div>
            <!-- Command Center -->
            <div class="panel">
                <div class="panel-title">Command Center</div>
                <div class="btn-group">
                    <button class="btn-primary" onclick="sendControl('start')">Start All Accounts</button>
                    <button class="btn-danger" onclick="sendControl('stop')">Stop / Pause Bot</button>
                    <button class="btn-secondary" style="background-color: #8b5cf6;" onclick="sendControl('confirm-ip')">Confirm IP Rotated</button>
                </div>
                <div class="single-acc-form">
                    <select id="single-email" class="text-input" style="cursor: pointer;">
                        <option value="">-- Select Account --</option>
                    </select>
                    <button class="btn-secondary" onclick="runSingle()">Start Single</button>
                </div>
            </div>

            <!-- Configuration Toggles -->
            <div class="panel">
                <div class="panel-title">Configuration Controls</div>
                
                <div class="toggle-item">
                    <div>
                        <strong>Dynamic WiFi Proxy</strong>
                        <div style="font-size:0.75rem; color:#94a3b8;">Route traffic via WiFi Hotspot</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="toggle-wifi-proxy" onchange="sendConfig()">
                        <span class="slider"></span>
                    </label>
                </div>

                <div class="toggle-item" style="margin-top:1.25rem;">
                    <div>
                        <strong>IP Rotation Mode</strong>
                        <div style="font-size:0.75rem; color:#94a3b8;" id="adb-mode-label">Mode: Auto (ADB Airplane Mode)</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="toggle-adb" onchange="sendConfig()">
                        <span class="slider"></span>
                    </label>
                </div>

                <div class="toggle-item" style="margin-top:1.25rem;">
                    <div>
                        <strong>Ghost Cursor (Human Mimicry)</strong>
                        <div style="font-size:0.75rem; color:#94a3b8;">Move mouse via natural Bezier curves</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="toggle-ghost" onchange="sendConfig()">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentStartTime = 0;
        let isBotRunning = false;

        function getStatusClass(status) {
            const s = status.toLowerCase();
            if (s.includes('pending')) return 'status-pending';
            if (s.includes('stealth')) return 'status-stealth';
            if (s.includes('login') || s.includes('auth')) return 'status-login';
            if (s.includes('completed') || s.includes('done')) return 'status-done';
            if (s.includes('error') || s.includes('failed') || s.includes('locked')) return 'status-error';
            return 'status-running';
        }

        async function sendControl(action, email = '') {
            try {
                await fetch('/api/control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action, email })
                });
            } catch(e) {
                console.error(e);
            }
        }

        function runSingle() {
            const email = document.getElementById('single-email').value.trim();
            if (email) {
                sendControl('start-single', email);
            }
        }

        let isUpdatingConfig = false;

        function updateAdbLabel(isChecked) {
            const labelElem = document.getElementById('adb-mode-label');
            if (labelElem) {
                if (isChecked) {
                    labelElem.innerHTML = 'Mode: <span style="color:#10b981; font-weight:600;">Auto (ADB Airplane Mode)</span>';
                } else {
                    labelElem.innerHTML = 'Mode: <span style="color:#f59e0b; font-weight:600;">Manual (LAN / Hotspot Prompt)</span>';
                }
            }
        }

        async function sendConfig() {
            if (isUpdatingConfig) return;
            isUpdatingConfig = true;

            const wifiToggle = document.getElementById('toggle-wifi-proxy');
            const adbToggle = document.getElementById('toggle-adb');
            const ghostToggle = document.getElementById('toggle-ghost');

            if (wifiToggle) wifiToggle.disabled = true;
            if (adbToggle) adbToggle.disabled = true;
            if (ghostToggle) ghostToggle.disabled = true;

            const useDynamicWifiProxy = wifiToggle ? wifiToggle.checked : false;
            const useAdbIpRotation = adbToggle ? adbToggle.checked : false;
            const useGhostCursor = ghostToggle ? ghostToggle.checked : true;

            updateAdbLabel(useAdbIpRotation);

            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ useDynamicWifiProxy, useAdbIpRotation, useGhostCursor })
                });
            } catch(e) {
                console.error(e);
            } finally {
                if (wifiToggle) wifiToggle.disabled = false;
                if (adbToggle) adbToggle.disabled = false;
                if (ghostToggle) ghostToggle.disabled = false;
                isUpdatingConfig = false;
            }
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                isBotRunning = data.isRunning;
                currentStartTime = data.startTime;

                // Update Header Pulse
                const pulseDot = document.getElementById('active-pulse');
                const statusText = document.getElementById('active-status-text');
                if (data.isRunning) {
                    pulseDot.className = 'pulse-dot';
                    statusText.innerText = 'C2 Running';
                } else {
                    pulseDot.className = 'pulse-dot idle';
                    statusText.innerText = 'C2 Standby';
                }

                // Update config toggles only if user is not actively updating config
                if (!isUpdatingConfig) {
                    const wifiToggle = document.getElementById('toggle-wifi-proxy');
                    const adbToggle = document.getElementById('toggle-adb');
                    const ghostToggle = document.getElementById('toggle-ghost');
                    if (wifiToggle && !wifiToggle.disabled) wifiToggle.checked = !!data.useDynamicWifiProxy;
                    if (adbToggle && !adbToggle.disabled) {
                        adbToggle.checked = !!data.useAdbIpRotation;
                        updateAdbLabel(adbToggle.checked);
                    }
                    if (ghostToggle && !ghostToggle.disabled) ghostToggle.checked = data.useGhostCursor ?? true;
                }

                // Update account selector dropdown
                if (data.loadedAccounts && Array.isArray(data.loadedAccounts)) {
                    const selectElem = document.getElementById('single-email');
                    if (selectElem) {
                        const currentVal = selectElem.value;
                        const existingValues = Array.from(selectElem.options).map(o => o.value).filter(Boolean);
                        
                        const isListChanged = data.loadedAccounts.length !== existingValues.length ||
                            data.loadedAccounts.some((email, idx) => email !== existingValues[idx]);

                        if (isListChanged) {
                            selectElem.innerHTML = '<option value="">-- Select Account --</option>';
                            data.loadedAccounts.forEach(email => {
                                const opt = document.createElement('option');
                                opt.value = email;
                                opt.textContent = email;
                                selectElem.appendChild(opt);
                            });
                            if (currentVal && data.loadedAccounts.includes(currentVal)) {
                                selectElem.value = currentVal;
                            }
                        }
                    }
                }

                // Update global stats
                const accountsArray = Object.values(data.accounts);
                document.getElementById('stat-total-accounts').innerText = accountsArray.length;
                
                const totalGained = accountsArray.reduce((sum, acc) => sum + (acc.collectedPoints || 0), 0);
                document.getElementById('stat-points-collected').innerText = '+' + totalGained;
                
                document.getElementById('stat-active-ip').innerText = data.currentIP;

                // Update accounts table
                const tbody = document.getElementById('accounts-table-body');
                if (accountsArray.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #64748b;">No accounts loaded yet.</td></tr>';
                    return;
                }

                tbody.innerHTML = accountsArray.map(acc => {
                    return '<tr>' +
                        '<td><strong>' + acc.email + '</strong></td>' +
                        '<td><span class="status-badge ' + getStatusClass(acc.status) + '">' + acc.status + '</span></td>' +
                        '<td>' + (acc.initialPoints || 0) + '</td>' +
                        '<td class="' + (acc.collectedPoints > 0 ? 'highlight-green' : '') + '">+' + (acc.collectedPoints || 0) + '</td>' +
                        '<td>' + (acc.desktopProgress || '0/0') + '</td>' +
                        '<td>' + (acc.mobileProgress || '0/0') + '</td>' +
                        '<td><span style="font-size: 0.875rem; color: #64748b;">' + acc.lastUpdate + '</span></td>' +
                        '</tr>';
                }).join('');

            } catch (err) {
                console.error('Error fetching dashboard status:', err);
            }
        }

        // Live runtime calculation
        function updateRuntime() {
            const runtimeEl = document.getElementById('stat-runtime');
            if (isBotRunning && currentStartTime > 0) {
                const elapsedSeconds = Math.floor((Date.now() - currentStartTime) / 1000);
                const mins = Math.floor(elapsedSeconds / 60);
                const secs = elapsedSeconds % 60;
                runtimeEl.innerText = mins + 'm ' + secs + 's';
            } else {
                runtimeEl.innerText = 'Idle';
            }
        }

        // Setup Event Source for Real-time streaming logs
        function setupLogStream() {
            const terminal = document.getElementById('terminal');
            const source = new EventSource('/api/logs');

            source.onmessage = function(event) {
                const div = document.createElement('div');
                div.className = 'log-line';
                
                // Colorize logs based on keywords
                let logText = event.data;
                if (logText.includes('[ERROR]')) {
                    div.style.color = '#ef4444';
                } else if (logText.includes('[WARN]')) {
                    div.style.color = '#f59e0b';
                } else if (logText.includes('[SUCCESS]') || logText.includes('SUKSES') || logText.includes('Completed')) {
                    div.style.color = '#34d399';
                } else if (logText.includes('[DEBUG]')) {
                    div.style.color = '#64748b';
                }
                
                div.innerText = logText;
                terminal.appendChild(div);
                
                // Keep terminal scrolled to bottom
                terminal.parentNode.scrollTop = terminal.parentNode.scrollHeight;
            };

            source.onerror = function() {
                source.close();
                // Reconnect after 3 seconds if disconnected
                setTimeout(setupLogStream, 3000);
            };
        }

        // Poll states
        setInterval(fetchStatus, 3000);
        setInterval(updateRuntime, 1000);
        
        fetchStatus();
        setupLogStream();
    </script>
</body>
</html>`

export class DashboardServer {
    private server: http.Server | null = null

    constructor(private port: number = 4000) {}

    private parseJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise(resolve => {
            let body = ''
            req.on('data', chunk => {
                body += chunk.toString()
            })
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body))
                } catch {
                    resolve({})
                }
            })
        })
    }

    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                const url = req.url || '/'
                const method = req.method || 'GET'

                if (method === 'GET') {
                    if (url === '/' || url === '/index.html') {
                        res.writeHead(200, { 'Content-Type': 'text/html' })
                        res.end(htmlPage)
                        return
                    }

                    if (url === '/api/status') {
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        let responseData = { ...dashboardState }
                        if (Database.getInstance().getIsConnected()) {
                            try {
                                const dbAccounts = await Database.getInstance().fetchAccountsSummary()
                                if (dbAccounts.length > 0) {
                                    const accountsObj: Record<string, any> = {}
                                    for (const acc of dbAccounts) {
                                        accountsObj[acc.email] = {
                                            email: acc.email,
                                            status: acc.status,
                                            initialPoints: acc.initialPoints,
                                            collectedPoints: acc.collectedPoints,
                                            desktopProgress: acc.desktopProgress,
                                            mobileProgress: acc.mobileProgress,
                                            lastUpdate: acc.lastUpdate
                                                ? new Date(acc.lastUpdate).toLocaleTimeString()
                                                : new Date().toLocaleTimeString()
                                        }
                                    }
                                    responseData.accounts = accountsObj
                                }
                            } catch {}
                        }
                        res.end(JSON.stringify(responseData))
                        return
                    }

                    if (url === '/api/logs') {
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            Connection: 'keep-alive'
                        })
                        // Stream connection header
                        res.write('data: Nexus C2 Log stream initialized\n\n')

                        const onLog = (msg: string) => {
                            const cleanMsg = msg.replace(/\n/g, ' ')
                            res.write(`data: ${cleanMsg}\n\n`)
                        }

                        logEmitter.on('log', onLog)

                        req.on('close', () => {
                            logEmitter.off('log', onLog)
                        })
                        return
                    }
                } else if (method === 'POST') {
                    if (url === '/api/control') {
                        const body = await this.parseJsonBody(req)
                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ success: true }))

                        if (body && body.action === 'confirm-ip') {
                            onIpConfirmCommand()
                        } else {
                            // Async run execution callbacks
                            void onControlCommand(body)
                        }
                        return
                    }

                    if (url === '/api/config') {
                        const body = await this.parseJsonBody(req)

                        // Update in-memory RAM dashboardState immediately
                        updateDashboardGlobal({
                            useDynamicWifiProxy: body.useDynamicWifiProxy ?? dashboardState.useDynamicWifiProxy,
                            useAdbIpRotation: body.useAdbIpRotation ?? dashboardState.useAdbIpRotation,
                            useGhostCursor: body.useGhostCursor ?? dashboardState.useGhostCursor
                        })

                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ success: true }))

                        // Dynamic write to config.json
                        try {
                            const configPath = path.join(process.cwd(), 'config.json')
                            const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
                            const updatedConfig = { ...currentConfig, ...body }
                            fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 4))

                            // Execute config reload callback
                            onConfigCommand()

                            // Emit logs to reflect update
                            logEmitter.emit(
                                'log',
                                `[CONFIG] Configuration updated via C2 Web UI: ${JSON.stringify(body)}`
                            )
                        } catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err)
                            logEmitter.emit('log', `[ERROR] Failed to save config to config.json: ${errMsg}`)
                        }
                        return
                    }
                }

                res.writeHead(404, { 'Content-Type': 'text/plain' })
                res.end('Not Found')
            })

            this.server.on('error', err => {
                reject(err)
            })

            this.server.listen(this.port, '0.0.0.0', () => {
                resolve()
            })
        })
    }

    public stop(): Promise<void> {
        return new Promise(resolve => {
            if (this.server) {
                this.server.close(() => resolve())
            } else {
                resolve()
            }
        })
    }

    public getPort(): number {
        return this.port
    }
}
