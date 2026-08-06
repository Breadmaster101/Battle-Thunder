import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { CONFIG, TERRAIN_CELL_SIZE } from './config.js';

function createSeededRNG(seed) {
    let rng = seed % 233280;
    return {
        random: function () {
            rng = (rng * 9301 + 49297) % 233280;
            return rng / 233280;
        }
    };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash);
}

let mapSeed = 42;
let simplex = new SimplexNoise(createSeededRNG(mapSeed));

// The map is seeded from the room code so every client generates the same world.
export function setMapSeed(seed) {
    mapSeed = seed;
    simplex = new SimplexNoise(createSeededRNG(mapSeed));
}
export function getMapSeed() { return mapSeed; }

function smoothstep(min, max, value) {
    const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return x * x * (3 - 2 * x);
}

function getTerrainHeight(x, z) {
    const nx = x / 6000;
    const nz = z / 6000;

    let continentRaw = simplex.noise(nx * 0.5 + mapSeed, nz * 0.5 + mapSeed) * 0.5 + 0.5;
    let continent = smoothstep(0.1, 0.6, continentRaw);
    let inland = smoothstep(0.4, 0.9, continentRaw);

    let ridge = 0;
    let rFreq = 1.0;
    let rAmp = 1.0;
    let rWeight = 1.0;
    for (let i = 0; i < 4; i++) {
        let n = 1.0 - Math.abs(simplex.noise(nx * rFreq * 1.2 + 10, nz * rFreq * 1.2 + 10));
        n = n * n;
        ridge += n * rAmp * rWeight;
        rWeight = Math.max(0.15, n * 1.5);
        rFreq *= 2.0;
        rAmp *= 0.4;
    }
    ridge = ridge / (1.0 + ridge * 0.3);

    let mSteps = 10.0;
    let warp = simplex.noise(nx * 8.0, nz * 8.0) * 0.04;
    let wRidge = ridge + warp;
    
    let rVal = wRidge * mSteps;
    let rFloor = Math.floor(rVal);
    let rFract = rVal - rFloor;
    
    let tilt = rFract * 0.35; 
    let riser = smoothstep(0.5, 1.0, rFract) * 0.65; 
    let mTerraced = (rFloor + tilt + riser) / mSteps;
    
    ridge = THREE.MathUtils.lerp(ridge, mTerraced, 0.7) * 900;

    let plateau = simplex.noise(nx * 2.0 + 50, nz * 2.0 + 50) * 0.5 + 0.5;
    
    let pSteps = 6.0;
    let pWarp = simplex.noise(nx * 6.0 + 20, nz * 6.0 + 20) * 0.05;
    let wPlateau = plateau + pWarp;

    let pVal = wPlateau * pSteps;
    let pFloor = Math.floor(pVal);
    let pFract = pVal - pFloor;

    let pTilt = pFract * 0.25;
    let pRiser = smoothstep(0.6, 1.0, pFract) * 0.75;
    let pTerraced = (pFloor + pTilt + pRiser) / pSteps;
    
    let mesa = THREE.MathUtils.lerp(plateau, pTerraced, 0.8) * 350;

    let hills = (simplex.noise(nx * 3.0 + 100, nz * 3.0 + 100) * 0.5 + 0.5) * 200;
    let foothills = hills + (simplex.noise(nx * 1.5 + 400, nz * 1.5 + 400) * 0.5 + 0.5) * 350;

    let biomeSelector = simplex.noise(nx * 0.8 + 200, nz * 0.8 + 200);

    let landHeight = 0;
    if (biomeSelector > 0.05) {
        let foothillTransition = smoothstep(0.05, 0.35, biomeSelector);
        let mountainTransition = smoothstep(0.25, 0.6, biomeSelector);
        let baseTerrain = THREE.MathUtils.lerp(hills, foothills, foothillTransition);
        let easedMountainTransition = Math.pow(mountainTransition, 1.8);
        landHeight = THREE.MathUtils.lerp(baseTerrain, ridge, easedMountainTransition);
    } else if (biomeSelector < -0.15) {
        let t = smoothstep(-0.15, -0.45, biomeSelector);
        landHeight = THREE.MathUtils.lerp(hills, mesa, t);
    } else {
        landHeight = hills;
    }

    landHeight = THREE.MathUtils.lerp(hills, landHeight, inland);

    let canyonNoise = Math.abs(simplex.noise(nx * 1.5 + 300, nz * 1.5 + 300));
    let canyonEdge = THREE.MathUtils.lerp(0.15, 0.45, smoothstep(200, 600, landHeight));
    let canyonMask = smoothstep(0.02, canyonEdge, canyonNoise);
    let canyonFade = smoothstep(300, 650, landHeight);
    canyonMask = THREE.MathUtils.lerp(canyonMask, 1.0, canyonFade);
    let canyonFloor = THREE.MathUtils.lerp(CONFIG.waterLevel - 20, 300, smoothstep(200, 800, landHeight));

    landHeight = THREE.MathUtils.lerp(canyonFloor, landHeight, canyonMask);

    let finalHeight = THREE.MathUtils.lerp(CONFIG.waterLevel - 80, landHeight, continent);

    let detail = simplex.noise(nx * 10.0, nz * 10.0) * 6.0;
    finalHeight += detail * canyonMask;

    return Math.max(CONFIG.waterLevel - 60, finalHeight);
}

// The broadphase used to be an array-of-arrays of boxed indices. It is now a
// flat CSR layout (offsets + a single Int32Array of triangle bases), which
// removes ~500k boxed numbers and keeps each cell's triangle list in one
// contiguous cache line run. Cells are also much smaller, so a height query
// tests a handful of triangles instead of ~80. Every triangle is still
// inserted into every cell its bounding box touches, so the value returned
// by getVisualTerrainHeight is bit-for-bit what it was before.
let terrainGrid = null;
let terrainGridStart = null;
let terrainCellMaxY = null;
let terrainPositions = null;

let TERRAIN_GRID_DIM = 0;

function buildTerrainGrid(positions) {
    terrainPositions = positions;
    window.terrainPositions = positions;
    TERRAIN_GRID_DIM = Math.ceil(CONFIG.width / TERRAIN_CELL_SIZE);
    const cellCount = TERRAIN_GRID_DIM * TERRAIN_GRID_DIM;
    const halfW = CONFIG.width / 2;
    const dim = TERRAIN_GRID_DIM;

    const counts = new Int32Array(cellCount);
    terrainCellMaxY = new Float32Array(cellCount);
    terrainCellMaxY.fill(-Infinity);

    // Pass 1: count references per cell and record the tallest vertex that
    // overlaps each cell. That ceiling lets flight/projectile code skip the
    // exact query entirely while it is clearly above the ground.
    for (let i = 0; i < positions.length; i += 9) {
        const ax = positions[i], az = positions[i+2];
        const bx = positions[i+3], bz = positions[i+5];
        const cx = positions[i+6], cz = positions[i+8];

        const minX = Math.min(ax, bx, cx) + halfW;
        const maxX = Math.max(ax, bx, cx) + halfW;
        const minZ = Math.min(az, bz, cz) + halfW;
        const maxZ = Math.max(az, bz, cz) + halfW;

        const startCol = Math.max(0, Math.floor(minX / TERRAIN_CELL_SIZE));
        const endCol = Math.min(dim - 1, Math.floor(maxX / TERRAIN_CELL_SIZE));
        const startRow = Math.max(0, Math.floor(minZ / TERRAIN_CELL_SIZE));
        const endRow = Math.min(dim - 1, Math.floor(maxZ / TERRAIN_CELL_SIZE));

        const triMaxY = Math.max(positions[i+1], positions[i+4], positions[i+7]);

        for (let r = startRow; r <= endRow; r++) {
            const rowBase = r * dim;
            for (let c = startCol; c <= endCol; c++) {
                const cell = rowBase + c;
                counts[cell]++;
                if (triMaxY > terrainCellMaxY[cell]) terrainCellMaxY[cell] = triMaxY;
            }
        }
    }

    terrainGridStart = new Int32Array(cellCount + 1);
    let total = 0;
    for (let i = 0; i < cellCount; i++) {
        terrainGridStart[i] = total;
        total += counts[i];
    }
    terrainGridStart[cellCount] = total;

    terrainGrid = new Int32Array(total);
    const cursor = new Int32Array(cellCount);

    // Pass 2: fill.
    for (let i = 0; i < positions.length; i += 9) {
        const ax = positions[i], az = positions[i+2];
        const bx = positions[i+3], bz = positions[i+5];
        const cx = positions[i+6], cz = positions[i+8];

        const minX = Math.min(ax, bx, cx) + halfW;
        const maxX = Math.max(ax, bx, cx) + halfW;
        const minZ = Math.min(az, bz, cz) + halfW;
        const maxZ = Math.max(az, bz, cz) + halfW;

        const startCol = Math.max(0, Math.floor(minX / TERRAIN_CELL_SIZE));
        const endCol = Math.min(dim - 1, Math.floor(maxX / TERRAIN_CELL_SIZE));
        const startRow = Math.max(0, Math.floor(minZ / TERRAIN_CELL_SIZE));
        const endRow = Math.min(dim - 1, Math.floor(maxZ / TERRAIN_CELL_SIZE));

        for (let r = startRow; r <= endRow; r++) {
            const rowBase = r * dim;
            for (let c = startCol; c <= endCol; c++) {
                const cell = rowBase + c;
                terrainGrid[terrainGridStart[cell] + cursor[cell]] = i;
                cursor[cell]++;
            }
        }
    }
}

// Conservative upper bound on the ground height near (x, z). Returns
// Infinity where no baked triangle data exists, so callers fall back to the
// exact query rather than assuming clear air.
const TERRAIN_CEILING_MARGIN = 150;
function getTerrainCellCeiling(x, z) {
    if (!terrainCellMaxY) return Infinity;
    const halfW = CONFIG.width / 2;
    const c = Math.floor((x + halfW) / TERRAIN_CELL_SIZE);
    const r = Math.floor((z + halfW) / TERRAIN_CELL_SIZE);
    if (c < 0 || c >= TERRAIN_GRID_DIM || r < 0 || r >= TERRAIN_GRID_DIM) return Infinity;
    const maxY = terrainCellMaxY[r * TERRAIN_GRID_DIM + c];
    return maxY === -Infinity ? Infinity : maxY + TERRAIN_CEILING_MARGIN;
}

function getTriangleHeightAtXZ(px, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (det === 0) return null;
    
    const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
    const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
    const l3 = 1.0 - l1 - l2;
    
    if (l1 >= -0.01 && l2 >= -0.01 && l3 >= -0.01) {
        return l1 * ay + l2 * by + l3 * cy;
    }
    return null;
}

function getVisualTerrainHeight(x, z) {
    const pos = terrainPositions;
    if (!terrainGrid || !pos) return getTerrainHeight(x, z);

    const halfW = CONFIG.width / 2;
    const c = Math.floor((x + halfW) / TERRAIN_CELL_SIZE);
    const r = Math.floor((z + halfW) / TERRAIN_CELL_SIZE);

    if (c >= 0 && c < TERRAIN_GRID_DIM && r >= 0 && r < TERRAIN_GRID_DIM) {
        const cell = r * TERRAIN_GRID_DIM + c;
        const end = terrainGridStart[cell + 1];
        let highest = -9999;
        let found = false;
        for (let j = terrainGridStart[cell]; j < end; j++) {
            const idx = terrainGrid[j];
            const ax = pos[idx], ay = pos[idx+1], az = pos[idx+2];
            const bx = pos[idx+3], by = pos[idx+4], bz = pos[idx+5];
            const cx = pos[idx+6], cy = pos[idx+7], cz = pos[idx+8];

            const h = getTriangleHeightAtXZ(x, z, ax, ay, az, bx, by, bz, cx, cy, cz);
            if (h !== null) {
                if (h > highest) highest = h;
                found = true;
            }
        }
        if (found) return highest;
    }
    return getTerrainHeight(x, z);
}

window.getSafeSpawn = function(minRadius = 1000, maxRadius = 3000) {
    let x = 0, z = 0, y = 800;
    let isSafe = false;
    let attempts = 0;
    
    while (!isSafe && attempts < 50) {
        const angle = Math.random() * Math.PI * 2;
        const r = minRadius + Math.random() * (maxRadius - minRadius);
        x = Math.sin(angle) * r;
        z = Math.cos(angle) * r;
        const terrainY = getTerrainHeight(x, z);
        
        y = Math.max(800, terrainY + 300); 
        
        let safeForward = true;
        const dir = new THREE.Vector3(-x, 0, -z).normalize();
        
        for(let d = 100; d <= 800; d += 100) {
            const checkX = x + dir.x * d;
            const checkZ = z + dir.z * d;
            const checkY = getTerrainHeight(checkX, checkZ);
            if (checkY >= y - 100) { 
                safeForward = false;
                break;
            }
        }
        
        if (safeForward) isSafe = true;
        attempts++;
    }
    if (!isSafe) { y = 1500; }
    return { x, y, z };
};

export {
    createSeededRNG, hashCode, smoothstep,
    getTerrainHeight, getVisualTerrainHeight, getTriangleHeightAtXZ,
    buildTerrainGrid, getTerrainCellCeiling
};
