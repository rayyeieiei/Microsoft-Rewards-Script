// Prevents additional console window on Windows in release, do not remove!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

// Fungsi saklar bot lu yang sebelumnya
#[tauri::command]
fn jalankan_bot_command() -> Result<String, String> {
    let output = Command::new("./NexusBot.exe")
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok("Panen kelar bre!".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// 🔥 FUNGSI BARU: Kurir penarik data akun
#[tauri::command]
fn load_accounts_data() -> Result<String, String> {
    // Trik pinter anak RPL: Kita bikin fallback path biar bisa jalan di mode Dev maupun .exe
    let paths = vec![
        "../accounts/accounts.json", // Path kalau lagi npx tauri dev
        "accounts/accounts.json",    // Path kalau udah jadi .exe
        "accounts.json"              // Fallback terakhir
    ];

    for path in paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            return Ok(content);
        }
    }
    
    Err("Waduh bre, file accounts.json lu gak ketemu!".to_string())
}

fn main() {
    tauri::Builder::default()
        // Daftarin fungsi kurir baru lu di sini biar dikenali sama frontend
        .invoke_handler(tauri::generate_handler![jalankan_bot_command, load_accounts_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}