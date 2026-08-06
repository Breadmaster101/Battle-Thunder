// Lobby-independent chrome: the FPS readout and the drop-down alert banner.

// --- CUSTOM UI NOTIFICATIONS ---
let alertTimeout;
export const showUIAlert = function(msg, duration = 3000) {
    const alertBox = document.getElementById('ui-alert');
    document.getElementById('ui-alert-text').innerText = msg;
    alertBox.style.display = 'block';
    
    // reset animation with guaranteed reflow
    alertBox.style.animation = 'none';
    void alertBox.offsetWidth; 
    alertBox.style.animation = 'dropDown 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';

    if(alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => { alertBox.style.display = 'none'; }, duration);
};

export function startFPSCounter() {
    const fpsEl = document.getElementById('fps-counter');
    let frames = 0;
    let lastTime = performance.now();
    function tickFPS() {
        frames++;
        const now = performance.now();
        const elapsed = now - lastTime;
        if (elapsed >= 500) {
            fpsEl.textContent = Math.round((frames * 1000) / elapsed);
            frames = 0;
            lastTime = now;
        }
        requestAnimationFrame(tickFPS);
    }
    requestAnimationFrame(tickFPS);
}
