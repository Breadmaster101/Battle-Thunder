import { SOCKET_URL } from './config.js';
import { G, players, netPlayers } from './state.js';
import { showUIAlert } from './ui.js';
import { setUICameraView } from './ui-3d.js';
import { Player } from './player.js';
import { updateLeaderboard } from './hud.js';
import { initGameWorld } from './world.js';

window.goToMenu = function () {
    const nameInput = document.getElementById('username');
    const usernameVal = nameInput.value.trim();
    if (!usernameVal) { showUIAlert("NO USERNAME ENTERED!"); return; }
    G.myUsername = usernameVal;

    if (!G.hasConnectedOnce || (G.socket && !G.socket.connected)) {
        document.getElementById('step-login').style.display = 'none';
        document.getElementById('step-connecting').style.display = 'block';
        setUICameraView('connecting');
    } else {
        document.getElementById('step-login').style.display = 'none';
        document.getElementById('step-menu').style.display = 'block';
        setUICameraView('menu');
    }

    if (!G.socket) {
        G.socket = io(SOCKET_URL, {
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            timeout: 10000
        });

        setTimeout(() => {
            if (!G.socket.connected && !G.hasConnectedOnce) {
                document.getElementById('connection-status').textContent = 'Server is starting up, please wait...';
            }
        }, 2000);

        G.socket.on('connect', () => {
            console.log("Connected to server");
            document.getElementById('step-connecting').style.display = 'none';
            document.getElementById('step-menu').style.display = 'block';
            setUICameraView('menu');
            G.hasConnectedOnce = true;
        });
        
        G.socket.on('disconnect', () => {
            if (G.gameActive && !G.isQuitting) {
                showUIAlert("LOST CONNECTION TO SERVER. RETURNING TO MENU...", 4000);
                G.gameActive = false;
                setTimeout(() => { window.quitGame(); }, 2000);
            }
        });

        G.socket.on('player_disconnected', (playerId) => {
            if (G.isHost) {
                for (let i = netPlayers.length - 1; i >= 0; i--) {
                    if (netPlayers[i].id === playerId) netPlayers.splice(i, 1);
                }
                if (!G.gameActive) {
                    updateLobbyUI();
                } else {
                    let p = null;
                    for (let i = 0; i < players.length; i++) {
                        if (players[i].socketId === playerId) { p = players[i]; break; }
                    }
                    if (p) p.dispose();
                }
                broadcastLobbyState();
            }
        });

        G.socket.on('error_msg', (msg) => {
            console.error('Server error:', msg);
            showUIAlert(msg);
            
            const joinBtn = document.querySelector('button[onclick="joinGame()"]');
            if (joinBtn && G.pendingJoinCode) {
                joinBtn.innerText = "JOIN SQUADRON";
                joinBtn.disabled = false;
                G.pendingJoinCode = null;
            }

            if (document.getElementById('step-waiting').style.display === 'block' && netPlayers.length === 0) {
                document.getElementById('step-waiting').style.display = 'none';
                document.getElementById('step-menu').style.display = 'block';
                setUICameraView('menu');
            }
        });

        G.socket.on('player_joined', (p) => {
            if (G.isHost) {
                const normalizedNewName = p.name.trim().toLowerCase();
                const nameExists = netPlayers.some(np => np.name.trim().toLowerCase() === normalizedNewName);
                
                if (nameExists) {
                    G.socket.emit('host_broadcast', {
                        roomCode: G.myRoomCode,
                        data: {
                            type: 'NAME_REJECTED',
                            targetId: p.id,
                            reason: `THE PILOT NAME "${p.name.toUpperCase()}" IS ALREADY IN USE.`
                        }
                    });
                    return;
                }

                const maxIdxNet = netPlayers.length > 0 ? Math.max(...netPlayers.map(n => n.index)) : -1;
                const maxIdxPlayers = players.length > 0 ? Math.max(...players.map(pl => pl.index)) : -1;
                const newIdx = Math.max(maxIdxNet, maxIdxPlayers) + 1;
                
                netPlayers.push({ id: p.id, name: p.name, index: newIdx });
                broadcastLobbyState();
                
                if (G.gameActive) {
                    G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: { type: 'START_GAME' } });
                    const newP = new Player({id: p.id, name: p.name, index: newIdx}, false);
                    newP.mesh.traverse(child => {
                        child.frustumCulled = false;
                        if (child.isMesh && child.material && G.csm) {
                            G.csm.setupMaterial(child.material);
                        }
                    });
                    players.push(newP);
                } else {
                    updateLobbyUI();
                }
            }
        });

        G.socket.on('game_data', (packet) => {
            if (packet.type === 'HOST_LEFT') {
                showUIAlert("HOST DISCONNECTED. RETURNING TO MENU...", 4000);
                const wasInGame = G.gameActive;
                G.gameActive = false;
                setTimeout(() => {
                    if (wasInGame) {
                        window.quitGame();
                    } else {
                        window.leaveSquadron();
                    }
                }, 2000);
                return;
            }
            if (packet.type === 'NAME_REJECTED') {
                if (G.socket.id === packet.targetId) {
                    showUIAlert(packet.reason, 4000);
                    G.pendingJoinCode = null;
                    const joinBtn = document.querySelector('button[onclick="joinGame()"]');
                    if (joinBtn) {
                        joinBtn.innerText = "JOIN SQUADRON";
                        joinBtn.disabled = false;
                    }
                    G.socket.disconnect();
                    document.getElementById('step-waiting').style.display = 'none';
                    document.getElementById('step-menu').style.display = 'block';
                    setUICameraView('menu');
                    G.isHost = false;
                    G.myRoomCode = "";
                    netPlayers.length = 0;
                    players.length = 0;
                    G.localPlayer = null;
                    G.socket.connect();
                }
                return;
            }
            if (packet.type === 'KICK_PLAYER') {
                if (G.socket.id === packet.targetId) {
                    showUIAlert("YOU HAVE BEEN KICKED FROM THE SQUADRON", 4000);
                    window.leaveSquadron();
                }
                return;
            }
            if (packet.type === 'LOBBY_UPDATE') {
                if (G.pendingJoinCode) {
                    G.myRoomCode = G.pendingJoinCode;
                    G.isHost = false;
                    G.pendingJoinCode = null;

                    const joinBtn = document.querySelector('button[onclick="joinGame()"]');
                    if (joinBtn) {
                        joinBtn.innerText = "JOIN SQUADRON";
                        joinBtn.disabled = false;
                    }

                    document.getElementById('step-menu').style.display = 'none';
                    document.getElementById('step-waiting').style.display = 'block';
                    document.getElementById('display-room-code').innerText = G.myRoomCode;
                    setUICameraView('waiting');
                }

                netPlayers.length = 0;

                for (let i = 0; i < packet.players.length; i++) netPlayers.push(packet.players[i]);
                
                if (!G.gameActive && !G.isGeneratingWorld) {
                    updateLobbyUI();
                } else {
                    netPlayers.forEach(np => {
                        let found = false;
                        for (let i = 0; i < players.length; i++) {
                            if (players[i].index === np.index) { found = true; break; }
                        }
                        if (!found) {
                            const newP = new Player(np, np.id === G.socket.id);
                            if (newP.mesh) {
                                newP.mesh.traverse(child => {
                                    child.frustumCulled = false;
                                    if (child.isMesh && child.material && G.csm) {
                                        G.csm.setupMaterial(child.material);
                                    }
                                });
                            }
                            players.push(newP);
                        }
                    });
                    
                    for (let i = 0; i < players.length; i++) {
                        let p = players[i];
                        let found = false;
                        for (let j = 0; j < netPlayers.length; j++) {
                            if (netPlayers[j].index === p.index) { found = true; break; }
                        }
                        if (!p.isLocal && !found) p.dispose();
                    }
                }

                if (!G.isHost) {
                    let me = null;
                    for (let i = 0; i < netPlayers.length; i++) {
                        if (netPlayers[i].id === G.socket.id) { me = netPlayers[i]; break; }
                    }
                    if (me) G.myPlayerIndex = me.index;
                }
            } else if (packet.type === 'START_GAME') {
                if (G.gameActive || G.isGeneratingWorld) return; 
                G.isGeneratingWorld = true;
                
                document.getElementById('lobby-overlay').style.display = 'none';
                const uiContainer = document.getElementById('ui-3d-container');
                if (uiContainer) document.getElementById('bake-overlay').appendChild(uiContainer);
                
                document.getElementById('bake-overlay').style.display = 'flex';
                setUICameraView('loading');

                setTimeout(() => {
                    initGameWorld(netPlayers, G.myRoomCode);
                }, 100);
            } else if (packet.type === 'GAME_STATE') {
                if (G.gameActive) handleGameState(packet);
            } else if (packet.type === 'HIT_EVENT') {
                if (G.gameActive && !G.isHost) { 
                    let target = null;
                    for (let i = 0; i < players.length; i++) {
                        if (players[i].index === packet.targetIdx) { target = players[i]; break; }
                    }
                    if (target && target.index === G.myPlayerIndex) {
                        target.takeDamage(packet.dmg, packet.attackerIdx);
                    }
                }
            }
        });

        G.socket.on('player_data', (packet) => {
            if (G.isHost) {
                if (packet.data.type === 'PLAYER_LEFT') {
                    for (let i = netPlayers.length - 1; i >= 0; i--) {
                        if (netPlayers[i].id === packet.data.id && netPlayers[i].index === packet.data.idx) {
                            netPlayers.splice(i, 1);
                        }
                    }
                    if (!G.gameActive) {
                        updateLobbyUI();
                    } else {
                        let p = null;
                        for (let i = 0; i < players.length; i++) {
                            if (players[i].index === packet.data.idx) { p = players[i]; break; }
                        }
                        if (p) p.dispose();
                    }
                    broadcastLobbyState();
                    return;
                }

                if (G.gameActive) {
                    let p = null;
                    for (let i = 0; i < players.length; i++) {
                        if (players[i].index === packet.data.idx) { p = players[i]; break; }
                    }
                    if (p) p.lastPacketTime = Date.now();

                    if (packet.data.type === 'PLAYER_DIED') {
                        const victim = p;
                        if (victim) {
                            victim.deaths++;
                            if (packet.data.attackerIdx !== null && packet.data.attackerIdx !== -1) {
                                let attacker = null;
                                for (let i = 0; i < players.length; i++) {
                                    if (players[i].index === packet.data.attackerIdx) { attacker = players[i]; break; }
                                }
                                if (attacker && attacker.index !== victim.index) {
                                    attacker.kills++;
                                }
                            }
                        }
                        return;
                    }

                    if (packet.data.type === 'HIT_EVENT') {
                        G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: packet.data });
                        let target = null;
                        for (let i = 0; i < players.length; i++) {
                            if (players[i].index === packet.data.targetIdx) { target = players[i]; break; }
                        }
                        if (target && (target.index === G.myPlayerIndex || target.isAI)) {
                            target.takeDamage(packet.data.dmg, packet.data.attackerIdx);
                        }
                        return;
                    }

                    if (p) {
                        p.syncData(packet.data);
                    }
                }
            }
        });
    } else {
        if (G.socket && !G.socket.connected) {
            G.socket.connect();
        }
    }
};

window.goBackToLogin = function() {
    if (G.socket) G.socket.disconnect();
    document.getElementById('step-menu').style.display = 'none';
    document.getElementById('step-login').style.display = 'block';
    setUICameraView('login');
};

window.leaveSquadron = function() {
    if (G.socket && G.socket.connected) {
        if (G.isHost) {
            G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: { type: 'HOST_LEFT' } });
        } else {
            G.socket.emit('client_send', { roomCode: G.myRoomCode, data: { type: 'PLAYER_LEFT', idx: G.myPlayerIndex, id: G.socket.id } });
        }
        setTimeout(() => {
            if (G.socket) G.socket.disconnect();
            completeLeave();
        }, 100);
    } else {
        completeLeave();
    }
};

function completeLeave() {
    document.getElementById('step-waiting').style.display = 'none';
    document.getElementById('step-menu').style.display = 'block';
    document.getElementById('display-room-code').innerText = "----";
    setUICameraView('menu');
    G.isHost = false;
    G.myRoomCode = "";
    netPlayers.length = 0;
    players.length = 0;
    G.localPlayer = null;
    if (G.socket) G.socket.connect();
}

window.quitGame = function() {
    G.isQuitting = true;
    if (G.socket && G.socket.connected) {
        if (G.isHost) {
            G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: { type: 'HOST_LEFT' } });
        } else {
            G.socket.emit('client_send', { roomCode: G.myRoomCode, data: { type: 'PLAYER_LEFT', idx: G.myPlayerIndex, id: G.socket.id } });
        }
        setTimeout(() => {
            if (G.socket) G.socket.disconnect();
            completeQuit();
        }, 100);
    } else {
        completeQuit();
    }
};

function completeQuit() {
    sessionStorage.setItem('returnToMenu', 'true');
    sessionStorage.setItem('username', G.myUsername);
    window.location.reload();
}

window.hostGame = function () {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    G.myRoomCode = code;
    G.isHost = true;
    G.myPlayerIndex = 0;
    netPlayers.length = 0;
    netPlayers.push({ id: G.socket.id, name: G.myUsername, index: 0 });

    G.socket.emit('create_room', code);

    document.getElementById('step-menu').style.display = 'none';
    document.getElementById('step-waiting').style.display = 'block';
    document.getElementById('display-room-code').innerText = code;
    document.getElementById('start-btn').style.display = 'block';
    document.getElementById('add-ai-btn').style.display = 'block';
    document.getElementById('waiting-msg').style.display = 'none';
    updateLobbyUI();
    setUICameraView('waiting');
};

window.joinGame = function () {
    const codeEl = document.getElementById('room-code-input');
    const code = codeEl.value.trim().toUpperCase().replace(/[^A-HJKMNPQRSTUVWXYZ2-9]/g, '');
    
    if (!code) { showUIAlert("NO ROOM CODE ENTERED!"); return; }
    if (code.length !== 4) { showUIAlert("ROOM CODE MUST BE 4 CHARACTERS"); return; }
    
    G.pendingJoinCode = code;
    
    const joinBtn = document.querySelector('button[onclick="joinGame()"]');
    if (joinBtn) {
        joinBtn.innerText = "JOINING...";
        joinBtn.disabled = true;
    }

    G.socket.emit('join_room', { roomCode: code, name: G.myUsername });
};

window.startGame = function () {
    if (!G.isHost) return;
    document.getElementById('lobby-overlay').style.display = 'none';
    
    const uiContainer = document.getElementById('ui-3d-container');
    if (uiContainer) document.getElementById('bake-overlay').appendChild(uiContainer);
    
    document.getElementById('bake-overlay').style.display = 'flex';
    setUICameraView('loading');

    G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: { type: 'START_GAME' } });

    setTimeout(() => {
        initGameWorld(netPlayers, G.myRoomCode);
    }, 100);
};

window.addAIPlane = function() {
    if (!G.isHost) return;
    const aiNames = [
        "Viper", "Maverick", "Goose", "Iceman", "Jester", "Hollywood", 
        "Wolfman", "Slider", "Cougar", "Merlin", "Sundown", "Chipper"
    ];
    let name = "AI PILOT";
    for (let candidate of aiNames) {
        if (!netPlayers.some(np => np.name.toUpperCase() === candidate.toUpperCase())) {
            name = candidate;
            break;
        }
    }
    if (name === "AI PILOT") {
        name = "AI PILOT " + (netPlayers.filter(np => np.isAI).length + 1);
    }
    
    const maxIdxNet = netPlayers.length > 0 ? Math.max(...netPlayers.map(n => n.index)) : -1;
    const maxIdxPlayers = players.length > 0 ? Math.max(...players.map(pl => pl.index)) : -1;
    const newIdx = Math.max(maxIdxNet, maxIdxPlayers) + 1;
    
    const aiId = "ai_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    
    netPlayers.push({ id: aiId, name: name, index: newIdx, isAI: true });
    
    if (G.gameActive) {
        const newP = new Player({id: aiId, name: name, index: newIdx, isAI: true}, false);
        newP.mesh.traverse(child => {
            child.frustumCulled = false;
            if (child.isMesh && child.material && G.csm) {
                G.csm.setupMaterial(child.material);
            }
        });
        players.push(newP);
    } else {
        updateLobbyUI();
    }
    
    broadcastLobbyState();
};

window.kickMember = function(id, index, isAI) {
    if (!G.isHost) return;
    
    if (isAI) {
        for (let i = netPlayers.length - 1; i >= 0; i--) {
            if (netPlayers[i].id === id) netPlayers.splice(i, 1);
        }
        if (G.gameActive) {
            let p = null;
            for (let i = 0; i < players.length; i++) {
                if (players[i].index === index) { p = players[i]; break; }
            }
            if (p) p.dispose();
        } else {
            updateLobbyUI();
        }
        broadcastLobbyState();
    } else {
        G.socket.emit('host_broadcast', {
            roomCode: G.myRoomCode,
            data: {
                type: 'KICK_PLAYER',
                targetId: id
            }
        });
        
        for (let i = netPlayers.length - 1; i >= 0; i--) {
            if (netPlayers[i].id === id) netPlayers.splice(i, 1);
        }
        if (G.gameActive) {
            let p = null;
            for (let i = 0; i < players.length; i++) {
                if (players[i].socketId === id) { p = players[i]; break; }
            }
            if (p) p.dispose();
        } else {
            updateLobbyUI();
        }
        broadcastLobbyState();
    }
};

function updateLobbyUI() {
    const startBtn = document.getElementById('start-btn');
    const addAiBtn = document.getElementById('add-ai-btn');
    const waitingMsg = document.getElementById('waiting-msg');
    if (startBtn && waitingMsg && addAiBtn) {
        if (G.isHost) {
            startBtn.style.display = 'block';
            addAiBtn.style.display = 'block';
            waitingMsg.style.display = 'none';
        } else {
            startBtn.style.display = 'none';
            addAiBtn.style.display = 'none';
            waitingMsg.style.display = 'block';
        }
    }

    const list = document.getElementById('player-list');
    list.innerHTML = "";
    const planePaletteColors = [
        '#FF0000', '#00FF00', '#FFFF00', '#FF00FF', '#FF8C00', 
        '#FFFFFF', '#7CFC00', '#DC143C', '#FF1493', '#FF4500'
    ];
    netPlayers.forEach(p => {
        const div = document.createElement('div');
        div.className = 'player-row';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.justifyContent = 'space-between';
        
        const leftSide = document.createElement('div');
        leftSide.style.display = 'flex';
        leftSide.style.alignItems = 'center';
        
        const colorHex = planePaletteColors[p.index % planePaletteColors.length];
        const swatch = document.createElement('span');
        swatch.className = 'player-swatch';
        swatch.style.backgroundColor = colorHex;
        leftSide.appendChild(swatch);
        
        const nameSpan = document.createElement('span');
        nameSpan.innerText = `[${p.index + 1}] ${p.name}`;
        if (p.isAI) {
            nameSpan.innerText += " (AI)";
        }
        leftSide.appendChild(nameSpan);
        
        if (p.index === 0) {
            const hostIcon = document.createElement('span');
            hostIcon.className = 'host-indicator';
            hostIcon.innerText = '★ HOST';
            leftSide.appendChild(hostIcon);
        }
        
        if (p.id === G.socket.id) leftSide.style.color = "#00ff00"; 
        div.appendChild(leftSide);

        if (G.isHost && p.id !== G.socket.id) {
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerText = 'KICK';
            kickBtn.style.padding = '4px 10px';
            kickBtn.style.fontSize = '0.75rem';
            kickBtn.style.width = 'auto';
            kickBtn.style.margin = '0';
            kickBtn.style.border = '1px solid #ff4444';
            kickBtn.style.color = '#ff4444';
            kickBtn.style.cursor = 'pointer';
            kickBtn.style.textDecoration = 'none'; 
            kickBtn.onmouseover = () => { kickBtn.style.background = '#ff4444'; kickBtn.style.color = '#000'; };
            kickBtn.onmouseout = () => { kickBtn.style.background = 'transparent'; kickBtn.style.color = '#ff4444'; };
            kickBtn.onclick = (e) => {
                e.stopPropagation();
                kickMember(p.id, p.index, p.isAI);
            };
            div.appendChild(kickBtn);
        }
        
        list.appendChild(div);
    });
}

function broadcastLobbyState() {
    G.socket.emit('host_broadcast', {
        roomCode: G.myRoomCode,
        data: { type: 'LOBBY_UPDATE', players: netPlayers }
    });
}

function handleGameState(packet) {
    G.lastGameStateTime = Date.now();

    for (let i = 0; i < packet.players.length; i++) {
        const pData = packet.players[i];
        let p = null;
        for (let j = 0; j < players.length; j++) {
            if (players[j].index === pData.idx) { p = players[j]; break; }
        }
        if (p) p.syncData(pData);
    }

    for (let i = players.length - 1; i >= 0; i--) {
        if (players[i].disconnected) players.splice(i, 1);
    }

    const now = Date.now();
    if (!window.lastLeaderboardUpdate || now - window.lastLeaderboardUpdate > 1000) {
        window.lastLeaderboardUpdate = now;
        updateLeaderboard();
    }
}

export { handleGameState, updateLobbyUI, broadcastLobbyState };
