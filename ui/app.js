// 🔥 FIX: Detektor Jembatan Tauri
const invoke = window.__TAURI__?.tauri?.invoke || async function(cmd) { 
    throw new Error("Tauri API Terputus! Pastikan 'withGlobalTauri': true udah diset di tauri.conf.json"); 
};

// ==========================================
// 🧮 LOGIKA KALKULATOR ALFAMART & RENDER UI
// ==========================================
const HARGA_100K = 8540;
const NILAI_PER_POIN = 100000 / HARGA_100K; // ~ Rp 11.7

const formatRp = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);

function updateDashboardStats(totalPoints, dailyPoints) {
    const estRupiah = totalPoints * NILAI_PER_POIN;
    const estMonthly = (dailyPoints * 30) * NILAI_PER_POIN;
    const progressPersen = Math.min((totalPoints / HARGA_100K) * 100, 100).toFixed(1);

    document.getElementById('total-points').innerText = `+${totalPoints} pts`;
    document.getElementById('est-rupiah').innerText = formatRp(estRupiah);
    document.getElementById('est-monthly').innerText = `${formatRp(estMonthly)} / bln`;
    
    document.getElementById('progress-text').innerText = `${progressPersen}% (${totalPoints} / ${HARGA_100K} pts)`;
    document.getElementById('progress-fill').style.width = `${progressPersen}%`;
}

function initChart() {
    const ctx = document.getElementById('pointsChart').getContext('2d');
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['06/06', '07/06', '08/06', '09/06', '10/06', '11/06', 'Hari Ini'],
            datasets: [{
                label: 'Poin Harian',
                data: [0, 0, 200, 850, 300, 0, 217],
                borderColor: '#00ffcc',
                backgroundColor: 'rgba(0, 255, 204, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                x: { grid: { display: false }, ticks: { color: '#64748b' } }
            }
        }
    });
}

// ==========================================
// 📡 MENGAMBIL 6 AKUN ELITE DARI BACKEND
// ==========================================
async function loadTableData() {
    const tbody = document.getElementById('account-list');
    
    try {
        const rawData = await invoke('load_accounts_data');
        const accounts = JSON.parse(rawData);
        
        tbody.innerHTML = ''; 
        let totalPoinKeseluruhan = 0;
        
        accounts.forEach(acc => {
            const poinAkun = acc.currentPoints || 0;
            totalPoinKeseluruhan += poinAkun;
            
            tbody.innerHTML += `
                <tr>
                    <td style="font-weight: 600;">${acc.email}</td>
                    <td style="color: #64748b;">-</td>
                    <td style="color: #00ffcc;">${poinAkun} pts</td>
                    <td><span style="color: #64748b;">Standby 😴</span></td>
                </tr>
            `;
        });
        
        updateDashboardStats(totalPoinKeseluruhan, 0);

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="4" style="color: #ef4444; text-align: center;">[ERROR] ${error}</td></tr>`;
        console.error("Gagal narik data:", error);
    }
}

// ==========================================
// 🚀 INISIALISASI
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
    await loadTableData();
    try {
        initChart();
    } catch (err) {
        console.warn("Grafik Chart.js diblokir, tapi tabel akun aman!", err);
    }
});

// ==========================================
// 🧭 NAVIGASI & TOMBOL
// ==========================================
document.getElementById('start-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('start-btn');
    const logBox = document.getElementById('log-output');
    btn.disabled = true; btn.innerText = "⏳ MEMANEN..."; btn.style.background = "#64748b";
    if(logBox) logBox.innerHTML += `<br>[SYSTEM] Sinyal dikirim ke Rust! Mengeksekusi NexusBot.exe...`;
    
    try {
        // Ini bakal nungguin bot .exe lu kelar kerja beneran
        const response = await invoke('jalankan_bot_command');
        if(logBox) logBox.innerHTML += `<br><span style="color: #00ffcc;">[SUCCESS] ${response}</span>`;
    } catch(err) {
        if(logBox) logBox.innerHTML += `<br><span style="color: #ef4444;">[ERROR] Bot gagal jalan: ${err}</span>`;
    } finally {
        btn.disabled = false; btn.innerText = "🚀 START PANEN POIN"; btn.style.background = "linear-gradient(135deg, #00ffcc, #0077ff)";
    }
});

const navDash = document.getElementById('nav-dash');
const navSet = document.getElementById('nav-set');
const tabDashboard = document.getElementById('tab-dashboard');
const tabSettings = document.getElementById('tab-settings');

navDash?.addEventListener('click', () => {
    navDash.classList.add('active'); navSet.classList.remove('active');
    tabDashboard.style.display = 'block'; tabSettings.style.display = 'none';
});

navSet?.addEventListener('click', () => {
    navSet.classList.add('active'); navDash.classList.remove('active');
    tabSettings.style.display = 'block'; tabDashboard.style.display = 'none';
});

setInterval(() => {
    console.log("Auto refreshing data tabel...");
    loadTableData();
}, 30000);