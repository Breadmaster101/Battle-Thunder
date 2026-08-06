// Entry point: wires the modules together and starts the lobby.
import { G, players, netPlayers } from './state.js';
import { NETWORK_TICK_RATE } from './config.js';
import { startFPSCounter, showUIAlert } from './ui.js';
import { initUI3D, setUICameraView } from './ui-3d.js';
import { resumeAudio } from './audio.js';
import { clearInputOnBlur } from './input.js';
import { updateLeaderboard } from './hud.js';
import { broadcastLobbyState } from './net.js';
import { onWindowResize } from './loop.js';

startFPSCounter();

initUI3D();
setUICameraView('login');
window.addEventListener('resize', onWindowResize);

window.onload = () => {
    if (sessionStorage.getItem('returnToMenu') === 'true') {
        sessionStorage.removeItem('returnToMenu');
        const savedName = sessionStorage.getItem('username');
        if (savedName) {
            document.getElementById('username').value = savedName;
            window.goToMenu();
        }
    }
};

// --- MULTIPLAYER NETWORK LOOP ---
setInterval(() => {
    if (!G.gameActive) return;
    const now = Date.now();
    
    const me = G.localPlayer;

    if (!G.isHost && G.gameActive) {
        if (G.lastGameStateTime > 0 && now - G.lastGameStateTime > 15000) {
            showUIAlert("HOST CONNECTION TIMED OUT. RETURNING TO MENU...", 4000);
            G.gameActive = false;
            setTimeout(() => { window.quitGame(); }, 2000);
        }
    }

    if (me) {
        const myData = {
            idx: me.index,
            pos: me.mesh.position,
            quat: { x: me.mesh.quaternion.x, y: me.mesh.quaternion.y, z: me.mesh.quaternion.z, w: me.mesh.quaternion.w },
            spd: me.speed, throt: me.throttle, hp: me.hp, crashed: me.isCrashed,
            killer: me.lastAttackerName, shoot: me.isFiring,
            spawned: !G.introCinematicActive
        };
        if (!G.isHost) G.socket.emit('client_send', { roomCode: G.myRoomCode, data: myData });
    }

    if (G.isHost) {
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!p.isLocal && !p.isAI && !p.disconnected && p.lastPacketTime && now - p.lastPacketTime > 10000) {
                p.dispose();
                for (let j = netPlayers.length - 1; j >= 0; j--) {
                    if (netPlayers[j].id === p.socketId) netPlayers.splice(j, 1);
                }
                broadcastLobbyState();
            }
        }
        
        for (let i = players.length - 1; i >= 0; i--) {
            if (players[i].disconnected) players.splice(i, 1);
        }

        const stateSnapshot = [];
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            let latestPos = p.mesh.position;
            let latestQuat = p.mesh.quaternion;
            let latestShoot = (p.index === G.myPlayerIndex || p.isAI ? p.isFiring : p.isShooting);
            
            if (!p.isLocal && !p.isAI && p.positionBuffer && p.positionBuffer.length > 0) {
                const latest = p.positionBuffer[p.positionBuffer.length - 1];
                latestPos = latest.pos;
                latestQuat = latest.quat;
                latestShoot = latest.shoot;
            }
            
            stateSnapshot.push({
                idx: p.index, 
                pos: latestPos,
                quat: { x: latestQuat.x, y: latestQuat.y, z: latestQuat.z, w: latestQuat.w },
                spd: p.speed, throt: p.throttle, hp: p.hp, crashed: p.isCrashed,
                k: p.kills, d: p.deaths, killer: p.lastAttackerName,
                shoot: latestShoot,
                spawned: p.isLocal ? !G.introCinematicActive : p.isSpawned
            });
        }

        G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: { type: 'GAME_STATE', players: stateSnapshot } });
        
        if (!window.lastLeaderboardUpdate || now - window.lastLeaderboardUpdate > 1000) {
            window.lastLeaderboardUpdate = now;
            updateLeaderboard();
        }
    }
}, NETWORK_TICK_RATE);

window.addEventListener('blur', clearInputOnBlur);
window.addEventListener('keydown', resumeAudio);
window.addEventListener('click', resumeAudio);
