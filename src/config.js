// Tunable constants. Nothing here holds state; see state.js for that.
import * as THREE from 'three';

const CONFIG = {
    width: 14000,
    segments: 350,
    waterLevel: 55,
    treeCount: 15000,
    shadowRes: 1024,
    fogDensity: 0.00008
};

const WORLD_SIZE = CONFIG.width;
const SOCKET_URL = "https://quicklash-server.onrender.com";

// Objects that also live on this layer are drawn a second time, alone, into a
// quarter-resolution target that gets blurred and added back over the frame.
// Only the handful of things that should glow are on it, so the extra pass
// costs a few dozen instanced quads rather than a second scene render.
const BLOOM_LAYER = 1;

// World-space direction *towards* the sun, matching the sky dome and the
// shadow cascade light direction. Used for the water's specular glitter.
const SUN_DIR = new THREE.Vector3(800, 500, -800).normalize();

const maxSpeed = 2.2;
const stallSpeed = 0.7;
const acceleration = 0.01;
const turnSpeed = 0.012;
const MAX_PLANE_AMMO = 67;

export const NETWORK_TICK_RATE = 50;
export const INTRO_DURATION = 3.5;

// Broadphase / instancing grid sizes.
export const TERRAIN_CELL_SIZE = 50;
export const TREE_GRID_SIZE = 400;
export const WORLD_CHUNK_DIM = 8;

export const MAX_PROJECTILES = 250;
export const AI_CLOUD_AIM_CONFIDENCE = 0.35;

// How often engine/listener AudioParam automation is re-armed, in ms.
export const ENGINE_PARAM_INTERVAL = 33;

export {
    CONFIG, WORLD_SIZE, SOCKET_URL, BLOOM_LAYER, SUN_DIR,
    maxSpeed, stallSpeed, acceleration, turnSpeed, MAX_PLANE_AMMO
};
