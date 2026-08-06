import { ENGINE_PARAM_INTERVAL } from './config.js';

const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();

const masterCompressor = audioCtx.createDynamicsCompressor();
masterCompressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
masterCompressor.knee.setValueAtTime(30, audioCtx.currentTime);
masterCompressor.ratio.setValueAtTime(12, audioCtx.currentTime);
masterCompressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
masterCompressor.release.setValueAtTime(0.25, audioCtx.currentTime);

const masterVolume = audioCtx.createGain();
masterVolume.gain.setValueAtTime(0.0, audioCtx.currentTime);

masterCompressor.connect(masterVolume);
masterVolume.connect(audioCtx.destination);

const reverbDuration = 2.0;
const reverbBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate * reverbDuration, audioCtx.sampleRate);
for (let i = 0; i < reverbBuffer.length; i++) {
    const decay = Math.pow(1 - i / reverbBuffer.length, 3.0);
    reverbBuffer.getChannelData(0)[i] = (Math.random() * 2 - 1) * decay;
    reverbBuffer.getChannelData(1)[i] = (Math.random() * 2 - 1) * decay;
}
const masterReverb = audioCtx.createConvolver();
masterReverb.buffer = reverbBuffer;
const reverbMix = audioCtx.createGain();
reverbMix.gain.value = 0.35;
masterReverb.connect(reverbMix);
reverbMix.connect(masterCompressor);

const VOLUME_STORAGE_KEY = 'bt-volume';

function loadSavedVolume() {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    const val = parseFloat(raw);
    return (raw !== null && !isNaN(val) && val >= 0 && val <= 1) ? val : 0;
}

function saveVolume(val) {
    try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(val));
    } catch (e) { /* storage unavailable (private mode, etc.) */ }
}

document.addEventListener("DOMContentLoaded", () => {
    const volSlider = document.getElementById('volume-slider');
    const volIcon = document.getElementById('volume-icon');

    const savedVol = loadSavedVolume();
    let isMuted = savedVol === 0;
    let preMuteVol = savedVol || 1.0;

    volSlider.value = savedVol;
    masterVolume.gain.setValueAtTime(savedVol, audioCtx.currentTime);

    function updateVolumeIcon(val) {
        if (val === 0) {
            volIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';
        } else if (val < 0.5) {
            volIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
        } else {
            volIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
        }
    }

    updateVolumeIcon(savedVol);

    volSlider.addEventListener('input', (e) => {
        resumeAudio();
        const val = parseFloat(e.target.value);
        masterVolume.gain.setValueAtTime(val, audioCtx.currentTime);
        isMuted = val === 0;
        updateVolumeIcon(val);
        saveVolume(val);
    });

    volIcon.addEventListener('click', () => {
        resumeAudio();
        if (isMuted) {
            masterVolume.gain.setValueAtTime(preMuteVol, audioCtx.currentTime);
            volSlider.value = preMuteVol;
            isMuted = false;
            updateVolumeIcon(preMuteVol);
            saveVolume(preMuteVol);
        } else {
            preMuteVol = parseFloat(volSlider.value) || 1.0;
            masterVolume.gain.setValueAtTime(0, audioCtx.currentTime);
            volSlider.value = 0;
            isMuted = true;
            updateVolumeIcon(0);
            saveVolume(0);
        }
    });
});

function createNoiseBuffer(dur = 1) {
    const sz = audioCtx.sampleRate * dur;
    const b = audioCtx.createBuffer(1, sz, audioCtx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1;
    return b;
}
const noiseBuf1 = createNoiseBuffer(1.0);
const noiseBufLoop = createNoiseBuffer(5.0);

function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50,
        n_samples = 44100,
        curve = new Float32Array(n_samples);
    let i = 0, x;
    for (; i < n_samples; ++i) {
        x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * (Math.PI / 180) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function resumeAudio() {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}
window.addEventListener('keydown', resumeAudio);
window.addEventListener('click', resumeAudio);

const SoundGen = {
    playShoot: (pos) => {
        const t = audioCtx.currentTime;
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 150;
        panner.maxDistance = 15000;
        panner.rolloffFactor = 0.8;
        if (pos) {
            panner.positionX.value = pos.x;
            panner.positionY.value = pos.y;
            panner.positionZ.value = pos.z;
        }
        panner.connect(masterCompressor);

        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.08);
        g.gain.setValueAtTime(0.6, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
        osc.connect(g); g.connect(panner);
        osc.start(t); osc.stop(t + 0.1);

        const m = audioCtx.createOscillator();
        m.type = 'triangle';
        const mg = audioCtx.createGain();
        m.frequency.setValueAtTime(1200, t);
        m.frequency.exponentialRampToValueAtTime(400, t + 0.04);
        mg.gain.setValueAtTime(0.3, t);
        mg.gain.exponentialRampToValueAtTime(0.01, t + 0.05);
        m.connect(mg); mg.connect(panner);
        m.start(t); m.stop(t + 0.05);

        const n = audioCtx.createBufferSource();
        n.buffer = noiseBuf1;
        const f = audioCtx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(4000, t);
        f.frequency.exponentialRampToValueAtTime(800, t + 0.15);
        const ng = audioCtx.createGain();
        ng.gain.setValueAtTime(1.0, t);
        ng.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
        n.connect(f); f.connect(ng);
        ng.connect(panner);
        panner.connect(masterReverb);
        n.start(t); n.stop(t + 0.25);
    },
    playExplosion: (pos) => {
        const t = audioCtx.currentTime;
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 600;
        panner.maxDistance = 25000;
        panner.rolloffFactor = 0.5;
        if (pos) {
            panner.positionX.value = pos.x;
            panner.positionY.value = pos.y;
            panner.positionZ.value = pos.z;
        }
        panner.connect(masterCompressor);

        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.frequency.setValueAtTime(80, t);
        osc.frequency.exponentialRampToValueAtTime(10, t + 1.5);
        g.gain.setValueAtTime(2.0, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + 2.0);
        osc.connect(g); g.connect(panner);
        osc.start(t); osc.stop(t + 2.0);

        const n = audioCtx.createBufferSource();
        n.buffer = noiseBufLoop;
        const f = audioCtx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1200, t);
        f.frequency.linearRampToValueAtTime(50, t + 2.5);
        const ng = audioCtx.createGain();
        ng.gain.setValueAtTime(2.0, t);
        ng.gain.exponentialRampToValueAtTime(0.01, t + 3.0);
        n.connect(f); f.connect(ng);
        ng.connect(panner);
        panner.connect(masterReverb);
        n.start(t); n.stop(t + 3.0);
    },
    playBulletWaterHit: (pos) => {
        const t = audioCtx.currentTime;
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 50;
        panner.maxDistance = 5000;
        panner.rolloffFactor = 1.0;
        if (pos) {
            panner.positionX.value = pos.x;
            panner.positionY.value = pos.y;
            panner.positionZ.value = pos.z;
        }
        panner.connect(masterCompressor);

        const n = audioCtx.createBufferSource();
        n.buffer = noiseBuf1;
        const f = audioCtx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(1200, t);
        f.Q.setValueAtTime(1.0, t);
        const ng = audioCtx.createGain();
        ng.gain.setValueAtTime(0.4, t);
        ng.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
        n.connect(f); f.connect(ng);
        ng.connect(panner);
        n.start(t); n.stop(t + 0.15);
    },
    playBulletDirtHit: (pos) => {
        const t = audioCtx.currentTime;
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 50;
        panner.maxDistance = 5000;
        panner.rolloffFactor = 1.0;
        if (pos) {
            panner.positionX.value = pos.x;
            panner.positionY.value = pos.y;
            panner.positionZ.value = pos.z;
        }
        panner.connect(masterCompressor);

        const n = audioCtx.createBufferSource();
        n.buffer = noiseBuf1;
        const f = audioCtx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(400, t);
        const ng = audioCtx.createGain();
        ng.gain.setValueAtTime(0.5, t);
        ng.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
        n.connect(f); f.connect(ng);
        ng.connect(panner);
        n.start(t); n.stop(t + 0.1);
    }
};

// Browsers may initialize HRTF, filter, and reverb processing on first use.
// Exercise every gameplay sound route silently before flight begins.
function warmUpAudioPipelines() {
    if (audioCtx.state !== 'running') return;

    const t = audioCtx.currentTime;
    const stopAt = t + 0.02;

    const warmRoute = ({ refDistance, maxDistance, rolloffFactor, reverb, oscillators, filters }) => {
        const nodes = [];
        const sources = [];
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = refDistance;
        panner.maxDistance = maxDistance;
        panner.rolloffFactor = rolloffFactor;
        panner.connect(masterCompressor);
        if (reverb) panner.connect(masterReverb);
        nodes.push(panner);

        for (let i = 0; i < oscillators.length; i++) {
            const oscillator = audioCtx.createOscillator();
            oscillator.type = oscillators[i];
            const gain = audioCtx.createGain();
            gain.gain.setValueAtTime(0, t);
            oscillator.connect(gain);
            gain.connect(panner);
            nodes.push(oscillator, gain);
            sources.push(oscillator);
        }

        for (let i = 0; i < filters.length; i++) {
            const noise = audioCtx.createBufferSource();
            noise.buffer = noiseBufLoop;
            const filter = audioCtx.createBiquadFilter();
            filter.type = filters[i];
            const gain = audioCtx.createGain();
            gain.gain.setValueAtTime(0, t);
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(panner);
            nodes.push(noise, filter, gain);
            sources.push(noise);
        }

        let completed = 0;
        const dispose = () => {
            completed++;
            if (completed !== sources.length) return;
            for (let i = 0; i < nodes.length; i++) nodes[i].disconnect();
        };
        for (let i = 0; i < sources.length; i++) {
            sources[i].onended = dispose;
            sources[i].start(t);
            sources[i].stop(stopAt);
        }
    };

    // Shoot, explosion, water hit, and dirt hit routes respectively.
    warmRoute({ refDistance: 150, maxDistance: 15000, rolloffFactor: 0.8, reverb: true, oscillators: ['sine', 'triangle'], filters: ['lowpass'] });
    warmRoute({ refDistance: 600, maxDistance: 25000, rolloffFactor: 0.5, reverb: true, oscillators: ['sine'], filters: ['lowpass'] });
    warmRoute({ refDistance: 50, maxDistance: 5000, rolloffFactor: 1.0, reverb: false, oscillators: [], filters: ['bandpass'] });
    warmRoute({ refDistance: 50, maxDistance: 5000, rolloffFactor: 1.0, reverb: false, oscillators: [], filters: ['lowpass'] });
}

class EngineSound {
    constructor(isLocal) {
        this.isLocal = isLocal;
        const t = audioCtx.currentTime;

        this.gain = audioCtx.createGain();
        this.gain.gain.value = 1.0;

        if (!isLocal) {
            this.panner = audioCtx.createPanner();
            this.panner.panningModel = 'HRTF';
            this.panner.distanceModel = 'inverse';
            this.panner.refDistance = 150;
            this.panner.maxDistance = 15000;
            this.panner.rolloffFactor = 0.8;
            this.gain.connect(this.panner);
            this.panner.connect(masterCompressor);
        } else {
            this.gain.connect(masterCompressor);
        }

        this.rumbleOsc = audioCtx.createOscillator();
        this.rumbleOsc.type = 'triangle';
        this.rumbleGain = audioCtx.createGain();
        this.rumbleOsc.connect(this.rumbleGain);
        this.rumbleGain.connect(this.gain);

        this.growlOsc = audioCtx.createOscillator();
        this.growlOsc.type = 'sawtooth';
        this.growlDistortion = audioCtx.createWaveShaper();
        this.growlDistortion.curve = makeDistortionCurve(150);
        this.growlFilter = audioCtx.createBiquadFilter();
        this.growlFilter.type = 'lowpass';
        this.growlFilter.Q.value = 1.0;
        this.growlGain = audioCtx.createGain();
        this.growlOsc.connect(this.growlDistortion);
        this.growlDistortion.connect(this.growlFilter);
        this.growlFilter.connect(this.growlGain);
        this.growlGain.connect(this.gain);

        this.propNoise = audioCtx.createBufferSource();
        this.propNoise.buffer = noiseBufLoop;
        this.propNoise.loop = true;
        this.propFilter = audioCtx.createBiquadFilter();
        this.propFilter.type = 'lowpass';
        this.propGate = audioCtx.createGain();
        this.propGain = audioCtx.createGain();
        this.propLFO = audioCtx.createOscillator();
        this.propLFO.type = 'sine';
        this.propNoise.connect(this.propFilter);
        this.propFilter.connect(this.propGate);
        this.propGate.connect(this.propGain);
        this.propGain.connect(this.gain);
        this.propLFO.connect(this.propGate.gain);

        this.whineOsc = audioCtx.createOscillator();
        this.whineOsc.type = 'sine';
        this.whineGain = audioCtx.createGain();
        this.whineOsc.connect(this.whineGain);
        this.whineGain.connect(this.gain);

        this.windNode = audioCtx.createBufferSource();
        this.windNode.buffer = noiseBufLoop;
        this.windNode.loop = true;
        this.windFilter = audioCtx.createBiquadFilter();
        this.windFilter.type = 'highpass';
        this.windGain = audioCtx.createGain();
        this.windNode.connect(this.windFilter);
        this.windFilter.connect(this.windGain);
        this.windGain.connect(this.gain);

        const now = audioCtx.currentTime;
        this.rumbleOsc.start(now);
        this.growlOsc.start(now);
        this.propNoise.start(now);
        this.propLFO.start(now);
        this.whineOsc.start(now);
        this.windNode.start(now);

        this.rumbleGain.gain.value = 0;
        this.growlGain.gain.value = 0;
        this.propGain.gain.value = 0;
        this.whineGain.gain.value = 0;
        this.windGain.gain.value = 0;
        this.isStopped = false;
        // Staggered so the planes do not all re-arm their automation on the
        // same frame.
        this._nextParamTime = performance.now() + Math.random() * ENGINE_PARAM_INTERVAL;
    }

    update(speed, throttle, pos) {
        // A remote player can become spawned without a reset event. Restore
        // its engine once here, rather than queuing repeated stop events.
        if (this.isStopped) this.restart();

        // Every parameter below is driven through setTargetAtTime with a 0.1s
        // time constant, so the audible signal is a smoothed exponential
        // approach rather than the raw per-frame value. Re-issuing that
        // automation at ~30Hz instead of at frame rate leaves the rendered
        // audio indistinguishable while cutting thousands of scheduled
        // AudioParam events per second off the main thread.
        const nowMs = performance.now();
        if (nowMs < this._nextParamTime) return;
        this._nextParamTime = nowMs + ENGINE_PARAM_INTERVAL;

        const t = audioCtx.currentTime;
        const dt = 0.1;

        const baseRPM = 800 + (throttle * 2000);
        const rpm = baseRPM + (speed * 100);
        const rps = rpm / 60;

        this.rumbleOsc.frequency.setTargetAtTime(rps * 3.0, t, dt);
        this.rumbleGain.gain.setTargetAtTime(0.2 + (throttle * 0.2), t, dt);

        this.growlOsc.frequency.setTargetAtTime(rps * 6.0, t, dt);
        this.growlFilter.frequency.setTargetAtTime(300 + (throttle * 1200), t, dt);
        this.growlGain.gain.setTargetAtTime(0.08 + (throttle * 0.12), t, dt);

        this.propLFO.frequency.setTargetAtTime(rps * 3, t, dt);
        this.propFilter.frequency.setTargetAtTime(600 + (throttle * 400), t, dt);
        this.propGain.gain.setTargetAtTime(0.15 + (throttle * 0.2), t, dt);

        this.whineOsc.frequency.setTargetAtTime(rps * 16, t, dt);
        this.whineGain.gain.setTargetAtTime(0.01 * throttle, t, dt);

        const windFreq = 1200 + (speed * 800);
        this.windFilter.frequency.setTargetAtTime(windFreq, t, dt);
        const windVol = Math.max(0, (speed - 1.2) * 0.01);
        this.windGain.gain.setTargetAtTime(windVol, t, dt);

        if (!this.isLocal && this.panner && pos) {
            this.panner.positionX.setTargetAtTime(pos.x, t, 0.1);
            this.panner.positionY.setTargetAtTime(pos.y, t, 0.1);
            this.panner.positionZ.setTargetAtTime(pos.z, t, 0.1);
        }
    }

    stop() {
        // Calling AudioParam automation every render frame accumulates a
        // large event queue for crashed/unspawned players. One fade reaches
        // the identical silent state.
        if (this.isStopped) return;
        this.isStopped = true;
        this.gain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    }

    restart() {
        this.isStopped = false;
        // Refresh the engine parameters on the very next update rather than
        // waiting out the throttle interval.
        this._nextParamTime = 0;
        this.gain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.1);
    }
}

export { audioCtx, masterCompressor, masterReverb, SoundGen, EngineSound, resumeAudio, warmUpAudioPipelines };
