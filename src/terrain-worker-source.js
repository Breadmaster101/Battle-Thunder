// Source for the world-generation worker, spawned from a Blob by initGameWorld.
// It runs off the main thread and cannot close over anything here, so the
// terrain functions it needs are duplicated inside rather than imported.
export const TERRAIN_WORKER_SOURCE = `
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { SimplexNoise } from 'https://unpkg.com/three@0.160.0/examples/jsm/math/SimplexNoise.js';

function createSeededRNG(seed) {
    let rng = seed % 233280;
    return {
        random: function () {
            rng = (rng * 9301 + 49297) % 233280;
            return rng / 233280;
        }
    };
}

function smoothstep(min, max, value) {
    const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return x * x * (3 - 2 * x);
}

self.onmessage = function(e) {
    const { CONFIG, mapSeed, TREE_GRID_SIZE } = e.data;
    const simplex = new SimplexNoise(createSeededRNG(mapSeed));

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

    self.postMessage({ status: 'GENERATING TERRAIN (1/3)...' });
    let geometry = new THREE.PlaneGeometry(CONFIG.width, CONFIG.width, CONFIG.segments, CONFIG.segments);
    geometry.rotateX(-Math.PI / 2);

    const gPos = geometry.attributes.position;
    const segmentSize = CONFIG.width / CONFIG.segments;

    for (let i = 0; i < gPos.count; i++) {
        let vx = gPos.getX(i);
        let vz = gPos.getZ(i);
        const jitterLimit = segmentSize * 0.45;
        vx += simplex.noise(vx * 0.05, vz * 0.05) * jitterLimit;
        vz += simplex.noise(vx * 0.05 + 100, vz * 0.05 + 100) * jitterLimit;
        gPos.setX(i, vx);
        gPos.setZ(i, vz);
        gPos.setY(i, getTerrainHeight(vx, vz));
    }

    // Shore map. The water surface is only 100 segments across 14km, so a river is
    // one or two vertices wide, and anything driven off a per-vertex depth snaps to
    // that grid. The shader instead samples this map per fragment.
    //
    // Bed heights are captured here, while they are still a regular (segments+1)^2
    // lattice - before toNonIndexed() shreds the geometry into a triangle soup - so
    // this reuses heights that were just computed and evaluates no extra noise.
    //
    // R = depth below the surface over SHORE_RANGE. The generator floors the bed at
    // waterLevel - 60, so that range covers every depth that exists.
    // G = distance out from the waterline over SHORE_DIST_RANGE, which is what the
    // foam band is measured in. RGBA rather than a packed two-channel format so the
    // rows stay 4-byte aligned on upload.
    const SHORE_RANGE = 60;
    const SHORE_DIST_RANGE = 320;
    const SHORE_TEX = 1024;
    const srcDim = CONFIG.segments + 1;

    const srcHeight = new Float32Array(srcDim * srcDim);
    for (let i = 0; i < gPos.count; i++) srcHeight[i] = gPos.getY(i);

    // Resampled up from the 40-unit terrain lattice to ~13.7 units. The foam band is
    // a few dozen units wide, so at 40 units the lattice and the feature were the
    // same size and every artefact in the field showed up as shape in the band.
    // Bilinear upsampling adds no noise evaluations, and the vertex jitter it ignores
    // is itself simplex-driven - a smooth, low-frequency offset rather than
    // high-frequency error.
    const shoreDepth = new Float32Array(SHORE_TEX * SHORE_TEX);
    const srcStep = (srcDim - 1) / (SHORE_TEX - 1);
    for (let y = 0; y < SHORE_TEX; y++) {
        const gy = y * srcStep;
        const y0 = Math.min(srcDim - 2, gy | 0);
        const fy = gy - y0;
        for (let x = 0; x < SHORE_TEX; x++) {
            const gx = x * srcStep;
            const x0 = Math.min(srcDim - 2, gx | 0);
            const fx = gx - x0;
            const i00 = y0 * srcDim + x0;
            const top = srcHeight[i00] * (1 - fx) + srcHeight[i00 + 1] * fx;
            const bot = srcHeight[i00 + srcDim] * (1 - fx) + srcHeight[i00 + srcDim + 1] * fx;
            shoreDepth[y * SHORE_TEX + x] = CONFIG.waterLevel - (top * (1 - fy) + bot * fy);
        }
    }

    // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher). The previous
    // chamfer approximation stepped only orthogonally and diagonally, so its contours
    // were octagons - which is what put angular white wedges on every headland and
    // river bend. This computes true Euclidean distance, so an offset from the
    // waterline is an actual offset curve.
    const EDT_INF = 1e20;
    const sqDist = new Float32Array(SHORE_TEX * SHORE_TEX);
    for (let i = 0; i < sqDist.length; i++) {
        sqDist[i] = shoreDepth[i] > 0 ? EDT_INF : 0;
    }

    const edtF = new Float32Array(SHORE_TEX);
    const edtD = new Float32Array(SHORE_TEX);
    const edtV = new Int32Array(SHORE_TEX);
    const edtZ = new Float32Array(SHORE_TEX + 1);

    function edt1d(n) {
        let k = 0;
        edtV[0] = 0;
        edtZ[0] = -EDT_INF;
        edtZ[1] = EDT_INF;
        for (let q = 1; q < n; q++) {
            let s = ((edtF[q] + q * q) - (edtF[edtV[k]] + edtV[k] * edtV[k])) / (2 * q - 2 * edtV[k]);
            while (s <= edtZ[k]) {
                k--;
                s = ((edtF[q] + q * q) - (edtF[edtV[k]] + edtV[k] * edtV[k])) / (2 * q - 2 * edtV[k]);
            }
            k++;
            edtV[k] = q;
            edtZ[k] = s;
            edtZ[k + 1] = EDT_INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (edtZ[k + 1] < q) k++;
            const dq = q - edtV[k];
            edtD[q] = dq * dq + edtF[edtV[k]];
        }
    }

    for (let x = 0; x < SHORE_TEX; x++) {
        for (let y = 0; y < SHORE_TEX; y++) edtF[y] = sqDist[y * SHORE_TEX + x];
        edt1d(SHORE_TEX);
        for (let y = 0; y < SHORE_TEX; y++) sqDist[y * SHORE_TEX + x] = edtD[y];
    }
    for (let y = 0; y < SHORE_TEX; y++) {
        const row = y * SHORE_TEX;
        for (let x = 0; x < SHORE_TEX; x++) edtF[x] = sqDist[row + x];
        edt1d(SHORE_TEX);
        for (let x = 0; x < SHORE_TEX; x++) sqDist[row + x] = edtD[x];
    }

    const shoreCell = CONFIG.width / (SHORE_TEX - 1);
    const shoreDim = SHORE_TEX;
    const shoreMap = new Uint8Array(SHORE_TEX * SHORE_TEX * 4);
    for (let i = 0; i < SHORE_TEX * SHORE_TEX; i++) {
        const dep = Math.max(0, Math.min(1, shoreDepth[i] / SHORE_RANGE));
        const dst = Math.max(0, Math.min(1, (Math.sqrt(sqDist[i]) * shoreCell) / SHORE_DIST_RANGE));
        shoreMap[i * 4] = dep * 255;
        shoreMap[i * 4 + 1] = dst * 255;
        shoreMap[i * 4 + 3] = 255;
    }

    self.postMessage({ status: 'GENERATING TERRAIN (2/3)...' });
    geometry.computeVertexNormals();
    geometry = geometry.toNonIndexed();
    geometry.computeVertexNormals();

    self.postMessage({ status: 'GENERATING TERRAIN (3/3)...' });
    const niPos = geometry.attributes.position;
    const niNorm = geometry.attributes.normal;
    const colors = new Float32Array(niPos.count * 3);
    const colorObj = new THREE.Color();

    for (let i = 0; i < niPos.count; i += 3) {
        const y0 = niPos.getY(i);
        const y1 = niPos.getY(i + 1);
        const y2 = niPos.getY(i + 2);
        const avgY = (y0 + y1 + y2) / 3;

        const ny = niNorm.getY(i);
        const slope = 1.0 - ny;
        const rv = simplex.noise(niPos.getX(i) * 0.01, niPos.getZ(i) * 0.01);

        if (avgY < CONFIG.waterLevel + 15 && slope < 0.15) {
            colorObj.setHex(0xdec98a);
            if (rv > 0.5) colorObj.setHex(0xe8d9a0);
            if (rv < -0.3) colorObj.setHex(0xd4bc74);
        } else if (avgY > 450 && slope < 0.5) {
            colorObj.setHex(0xf0eef8);
            if (rv > 0.3) colorObj.setHex(0xe8e6f0);
        } else if (slope > 0.55 || (avgY > 300 && slope > 0.4)) {
            colorObj.setHex(0x8a7e72);
            if (rv > 0) colorObj.setHex(0x7d6f63);
            if (rv < -0.3) colorObj.setHex(0x968a7e);
        } else if (slope > 0.35 && avgY < 300) {
            colorObj.setHex(0x9e8a6a);
            if (rv > 0.3) colorObj.setHex(0x8b7858);
        } else {
            if (avgY < 120) {
                colorObj.setHex(0x5da04a);
                if (rv > 0.3) colorObj.setHex(0x6db85a);
                if (rv < -0.3) colorObj.setHex(0x4e9040);
            } else if (avgY < 250) {
                colorObj.setHex(0x4a8838);
                if (rv > 0.3) colorObj.setHex(0x3d7830);
                if (rv < -0.3) colorObj.setHex(0x559845);
            } else {
                colorObj.setHex(0x7aaa55);
                if (rv > 0.3) colorObj.setHex(0x6d9a4a);
                if (rv < -0.3) colorObj.setHex(0x88b862);
            }
        }
        colors[i * 3] = colorObj.r;
        colors[i * 3 + 1] = colorObj.g;
        colors[i * 3 + 2] = colorObj.b;

        colors[(i + 1) * 3] = colorObj.r;
        colors[(i + 1) * 3 + 1] = colorObj.g;
        colors[(i + 1) * 3 + 2] = colorObj.b;

        colors[(i + 2) * 3] = colorObj.r;
        colors[(i + 2) * 3 + 1] = colorObj.g;
        colors[(i + 2) * 3 + 2] = colorObj.b;
    }

    self.postMessage({ status: 'PLANTING FORESTS...' });
    
    const MAX_PINE = CONFIG.treeCount;
    const MAX_DECID = CONFIG.treeCount;
    const MAX_ROCK = 5000;

    const pineData = new Float32Array(MAX_PINE * 6);
    const decidData = new Float32Array(MAX_DECID * 6);
    const rockData = new Float32Array(MAX_ROCK * 6);

    let pineCount = 0;
    let decidCount = 0;
    let rockCount = 0;

    let rngT = mapSeed;
    const myRandom = () => { rngT = (rngT * 9301 + 49297) % 233280; return rngT / 233280; };
    
    const totalAttempts = CONFIG.treeCount * 4;
    for (let i = 0; i < totalAttempts; i++) {
        const x = (myRandom() - 0.5) * CONFIG.width;
        const z = (myRandom() - 0.5) * CONFIG.width;
        const y = getTerrainHeight(x, z);
        const y1 = getTerrainHeight(x + 5, z);
        const y2 = getTerrainHeight(x, z + 5);
        const slope = Math.sqrt(Math.pow(y - y1, 2) + Math.pow(y - y2, 2));

        if (y > CONFIG.waterLevel + 8) {
            const clumpNoise = simplex.noise(x * 0.002, z * 0.002);
            const scale = 0.8 + myRandom() * 1.0;
            const rot = myRandom() * Math.PI * 2;

            if (slope > 0.4 && y < 500) {
                if (rockCount < MAX_ROCK && myRandom() > 0.5) {
                    rockData[rockCount*6] = x; rockData[rockCount*6+1] = y - 1; rockData[rockCount*6+2] = z;
                    rockData[rockCount*6+3] = scale * 1.5; rockData[rockCount*6+4] = scale * 1.5; rockData[rockCount*6+5] = rot;
                    rockCount++;
                }
            }
            else if (slope < 0.3 && y < 350) {
                if (clumpNoise > 0.2) {
                    if (pineCount + decidCount < CONFIG.treeCount) {
                        const scaleY = scale * (0.8 + myRandom() * 0.4);
                        if (y < 200 && myRandom() > 0.3) {
                            decidData[decidCount*6] = x; decidData[decidCount*6+1] = y - 1; decidData[decidCount*6+2] = z;
                            decidData[decidCount*6+3] = scale; decidData[decidCount*6+4] = scaleY; decidData[decidCount*6+5] = rot;
                            decidCount++;
                        } else {
                            pineData[pineCount*6] = x; pineData[pineCount*6+1] = y - 1; pineData[pineCount*6+2] = z;
                            pineData[pineCount*6+3] = scale; pineData[pineCount*6+4] = scaleY; pineData[pineCount*6+5] = rot;
                            pineCount++;
                        }
                    }
                }
            }
        }
    }

    const posArray = niPos.array;
    const normArray = niNorm.array;
    
    const pSlice = pineData.slice(0, pineCount * 6);
    const dSlice = decidData.slice(0, decidCount * 6);
    const rSlice = rockData.slice(0, rockCount * 6);

    self.postMessage({
        done: true,
        positions: posArray,
        normals: normArray,
        colors: colors,
        pineData: pSlice,
        decidData: dSlice,
        rockData: rSlice,
        shoreMap: shoreMap,
        shoreDim: shoreDim,
        shoreRange: SHORE_RANGE,
        shoreDistRange: SHORE_DIST_RANGE,
        pineCount, decidCount, rockCount
    }, [
        posArray.buffer,
        normArray.buffer,
        colors.buffer,
        pSlice.buffer,
        dSlice.buffer,
        rSlice.buffer,
        shoreMap.buffer
    ]);
};
`;
