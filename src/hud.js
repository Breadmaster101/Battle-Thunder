import { CONFIG } from './config.js';
import { G, players } from './state.js';
import { _tempVec, _tempDiff } from './scratch.js';

// Cached DOM Elements for HUD (Prevents Layout Thrashing)
const _DOM = {};
function cacheDOM() {
    _DOM.speedVal = document.getElementById('speedVal');
    _DOM.throtVal = document.getElementById('throtVal');
    _DOM.hpVal = document.getElementById('hpVal');
    _DOM.altVal = document.getElementById('altVal');
    _DOM.altValContainerStyle = document.getElementById('altValContainer').style;
    _DOM.headingVal = document.getElementById('headingVal');
    _DOM.ammoText = document.getElementById('ammoText');
    _DOM.ammoTextStyle = _DOM.ammoText.style;
    _DOM.ammoBarStyle = document.getElementById('ammoBar').style;
    _DOM.reloadWarnStyle = document.getElementById('reloadWarn').style;
    _DOM.stallWarnStyle = document.getElementById('stallWarn').style;
    _DOM.cloudWhiteoutStyle = document.getElementById('cloud-whiteout').style;
}

const _hudCache = { speed: -1, throt: -1, alt: -1, hdg: -1, hp: -1, stall: null, ammo: -1, reloading: null, cloudWhiteout: false };

function updateLeaderboard() {
    const sortedPlayers = [];
    for (let i = 0; i < players.length; i++) {
        if (!players[i].disconnected) sortedPlayers.push(players[i]);
    }
    
    sortedPlayers.sort((a, b) => {
        if (b.kills !== a.kills) return b.kills - a.kills;
        return a.deaths - b.deaths;
    });
    
    const tbody = document.getElementById('leaderboard-body');
    tbody.innerHTML = '';

    for (let i = 0; i < sortedPlayers.length; i++) {
        const p = sortedPlayers[i];
        const tr = document.createElement('tr');
        if (p.index === G.myPlayerIndex) tr.classList.add('current-player-row');

        const nameTd = document.createElement('td');
        nameTd.innerText = p.isAI ? `${p.name} (AI)` : p.name;

        const cTd = document.createElement('td');
        const colorBox = document.createElement('div');
        colorBox.className = 'color-indicator';
        colorBox.style.backgroundColor = '#' + p.color.getHexString();
        cTd.appendChild(colorBox);

        const kTd = document.createElement('td');
        kTd.innerText = p.kills;
        const dTd = document.createElement('td');
        dTd.innerText = p.deaths;

        tr.appendChild(nameTd);
        tr.appendChild(cTd);
        tr.appendChild(kTd);
        tr.appendChild(dTd);
        tbody.appendChild(tr);
    }
}

function updateHUD(me) {
    const speed = Math.round(me.speed * 160);
    if (speed !== _hudCache.speed) {
        _DOM.speedVal.innerText = speed;
        _hudCache.speed = speed;
    }
    const throt = Math.round(me.throttle * 100);
    if (throt !== _hudCache.throt) {
        _DOM.throtVal.innerText = throt;
        _hudCache.throt = throt;
    }
    if (me.hp !== _hudCache.hp) {
        _DOM.hpVal.innerText = me.hp;
        _hudCache.hp = me.hp;
    }
    const alt = Math.round(me.mesh.position.y - CONFIG.waterLevel);
    if (alt !== _hudCache.alt) {
        _DOM.altVal.innerText = alt;
        _DOM.altValContainerStyle.color = alt < 20 ? '#ff4444' : '#ffffff';
        _hudCache.alt = alt;
    }

    _tempVec.set(0, 0, -1).applyQuaternion(me.mesh.quaternion);
    const headingAngle = Math.atan2(_tempVec.x, _tempVec.z);
    let degrees = Math.round(headingAngle * (180 / Math.PI));
    if (degrees < 0) degrees += 360;

    if (degrees !== _hudCache.hdg) {
        _DOM.headingVal.innerText = degrees;
        _hudCache.hdg = degrees;
    }

    if (me.isReloading) {
        const now = Date.now();
        let progress = (now - me.reloadTimerStart) / me.reloadTime;
        if (progress > 1) progress = 1;
        _DOM.ammoBarStyle.width = (progress * 100) + "%";
        
        if (_hudCache.reloading !== true) {
            _DOM.ammoText.innerText = "0";
            _DOM.ammoTextStyle.color = '#ffaa00';
            _DOM.ammoBarStyle.background = '#ffaa00';
            _DOM.reloadWarnStyle.display = 'block';
            _hudCache.reloading = true;
        }
    } else {
        if (_hudCache.ammo !== me.currentAmmo || _hudCache.reloading === true) {
            _DOM.ammoText.innerText = me.currentAmmo;
            _DOM.ammoTextStyle.color = '#ffffff';
            _DOM.ammoBarStyle.width = ((me.currentAmmo / me.maxAmmo) * 100) + "%";
            _DOM.ammoBarStyle.background = '#ffffff';
            _DOM.reloadWarnStyle.display = 'none';
            _hudCache.ammo = me.currentAmmo;
            _hudCache.reloading = false;
        }
    }

    const showStall = me.isStalled && !me.isCrashed;
    if (showStall !== _hudCache.stall) {
        _DOM.stallWarnStyle.display = showStall ? 'block' : 'none';
        _hudCache.stall = showStall;
    }

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.index === G.myPlayerIndex || p.disconnected) continue; 

        const blipStyle = p.radarBlipStyle;
        if (!p.isCrashed && p.mesh.visible && p.isSpawned && blipStyle) {
            _tempDiff.subVectors(p.mesh.position, me.mesh.position);
            const enemyAngle = Math.atan2(_tempDiff.x, _tempDiff.z);
            const delta = headingAngle - enemyAngle;
            const distFlat = Math.sqrt(_tempDiff.x * _tempDiff.x + _tempDiff.z * _tempDiff.z);

            let rX = Math.sin(delta) * distFlat * 0.3;
            let rY = -Math.cos(delta) * distFlat * 0.3;

            const dist = Math.sqrt(rX * rX + rY * rY);
            if (dist > 65) {
                const ratio = 65 / dist;
                rX *= ratio; rY *= ratio;
            }
            blipStyle.transform = `translate(-50%, -50%) translate(${70 + rX}px, ${70 + rY}px)`;
            // Re-assigning an unchanged display value still dirties style on
            // every frame; only write it on an actual transition.
            if (p._blipVisible !== true) {
                blipStyle.display = 'block';
                p._blipVisible = true;
            }
        } else if (blipStyle) {
            if (p._blipVisible !== false) {
                blipStyle.display = 'none';
                p._blipVisible = false;
            }
        }
    }
}

export { _DOM, _hudCache, cacheDOM, updateLeaderboard, updateHUD };
