import { G } from './state.js';

export const inputState = {
    pitchDown: false, pitchUp: false,
    rollLeft: false, rollRight: false,
    yawLeft: false, yawRight: false,
    throttleUp: false, throttleDown: false,
    shoot: false,
    lookBack: false
};

function handleKey(e, state) {
    const key = e.key.toLowerCase();
    const code = e.code;

    if (code === 'KeyW' || code === 'ArrowUp') inputState.pitchDown = state;
    if (code === 'KeyS' || code === 'ArrowDown') inputState.pitchUp = state;
    if (code === 'KeyA' || code === 'ArrowLeft') inputState.rollLeft = state;
    if (code === 'KeyD' || code === 'ArrowRight') inputState.rollRight = state;
    if (code === 'KeyQ') inputState.yawLeft = state;
    if (code === 'KeyE') inputState.yawRight = state;
    if (code === 'ShiftLeft' || code === 'ShiftRight') inputState.throttleUp = state;
    if (code === 'Space') inputState.throttleDown = state;
    if (code === 'KeyF' || code === 'Enter') inputState.shoot = state;
    if (code === 'KeyB') inputState.lookBack = state;

    const me = G.localPlayer;
    if (me) {
        me.inputs = {
            pitch: (inputState.pitchDown ? -1 : 0) + (inputState.pitchUp ? 1 : 0),
            roll: (inputState.rollLeft ? 1 : 0) + (inputState.rollRight ? -1 : 0),
            yaw: (inputState.yawLeft ? 1 : 0) + (inputState.yawRight ? -1 : 0),
            throttle: (inputState.throttleUp ? 1 : 0) + (inputState.throttleDown ? -1 : 0),
            shoot: inputState.shoot,
            reset: false
        };
    }
}

// Held keys would otherwise stay latched while the tab is in the background.
export function clearInputOnBlur() {
    inputState.pitchDown = false;
    inputState.pitchUp = false;
    inputState.rollLeft = false;
    inputState.rollRight = false;
    inputState.yawLeft = false;
    inputState.yawRight = false;
    inputState.throttleUp = false;
    inputState.throttleDown = false;
    inputState.shoot = false;
    inputState.lookBack = false;

    const me = G.localPlayer;
    if (me) {
        me.inputs.pitch = 0;
        me.inputs.roll = 0;
        me.inputs.yaw = 0;
        me.inputs.throttle = 0;
        me.inputs.shoot = false;
    }
}

export { handleKey };
