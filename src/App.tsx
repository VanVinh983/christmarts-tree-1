import { useState, useMemo, useRef, useEffect, Suspense, useCallback } from 'react';
import { Canvas, useFrame, extend, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 31.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 31;
// 修改：将 top.jpg 加入到数组开头
const bodyPhotoPaths = [
  '/photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `/photos/${i + 1}.jpg`)
];

// --- 视觉配置 ---
const CONFIG = {
  colors: {
    emerald: '#004225', // 纯正祖母绿
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#D32F2F',
    green: '#2E7D32',
    white: '#FFFFFF',   // 纯白色
    warmLight: '#FFD54F',
    // Palette lock: chỉ dùng đỏ + vàng kim
    lights: ['#FFD700', '#D32F2F'], // 彩灯 (gold/red only)
    // 拍立得边框颜色池 (gold/red only)
    borders: ['#FFD700', '#FFC107', '#D32F2F', '#B71C1C'],
    // 圣诞元素颜色
    giftColors: ['#D32F2F', '#FFD700'],
    candyColors: ['#D32F2F', '#FFD700']
  },
  counts: {
    foliage: 15000,
    ornaments: 300,   // 拍立得照片数量
    elements: 200,    // 圣诞元素数量
    lights: 400       // 彩灯数量
  },
  tree: { height: 22, radius: 9 }, // 树体尺寸
  photos: {
    // top 属性不再需要，因为已经移入 body
    body: bodyPhotoPaths
  }
};

// Focus/Zoom tuning (pinch)
const FOCUS_DISTANCE = 18; // world units in front of camera

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
        <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

// --- Component: Photo Ornaments (Double-Sided Polaroid) ---
const PhotoOrnaments = ({
  state,
  zoomIndex,
  zoomActive,
}: {
  state: 'CHAOS' | 'FORMED';
  zoomIndex: number | null;
  zoomActive: boolean;
}) => {
  const textures = useTexture(CONFIG.photos.body);
  const count = CONFIG.counts.ornaments;
  const groupRef = useRef<THREE.Group>(null);
  const tempScale = useMemo(() => new THREE.Vector3(), []);
  const { camera } = useThree();
  const tempDir = useMemo(() => new THREE.Vector3(), []);
  const tempTargetWorld = useMemo(() => new THREE.Vector3(), []);
  const tempTargetLocal = useMemo(() => new THREE.Vector3(), []);
  const tempNormalQuat = useMemo(() => new THREE.Quaternion(), []);
  const tempTargetQuat = useMemo(() => new THREE.Quaternion(), []);

  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(1.2, 1.5), []);
  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map((_, i) => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, (Math.random()-0.5)*70, (Math.random()-0.5)*70);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const isBig = Math.random() < 0.2;
      const baseScale = isBig ? 2.2 : 0.8 + Math.random() * 0.6;
      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];

      const rotationSpeed = {
        x: (Math.random() - 0.5) * 1.0,
        y: (Math.random() - 0.5) * 1.0,
        z: (Math.random() - 0.5) * 1.0
      };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      return {
        chaosPos, targetPos, scale: baseScale, weight,
        textureIndex: i % textures.length,
        borderColor,
        currentPos: chaosPos.clone(),
        chaosRotation,
        rotationSpeed,
        wobbleOffset: Math.random() * 10,
        wobbleSpeed: 0.5 + Math.random() * 0.5,
        zoomT: 0
      };
    });
  }, [textures, count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    groupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      // We'll blend position to a "focus" pose when zooming
      group.position.copy(objData.currentPos);

      if (isFormed) {
         const targetLookPos = new THREE.Vector3(group.position.x * 2, group.position.y + 0.5, group.position.z * 2);
         group.lookAt(targetLookPos);

         const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.05;
         const wobbleZ = Math.cos(time * objData.wobbleSpeed * 0.8 + objData.wobbleOffset) * 0.05;
         group.rotation.x += wobbleX;
         group.rotation.z += wobbleZ;

      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }

      // Pinch zoom: focus 1 bức ảnh (ra trước camera + nằm giữa màn hình + xoay mặt về camera + phóng to)
      const isFocused = zoomActive && zoomIndex === i;
      const targetZoomT = isFocused ? 1 : 0;
      objData.zoomT = MathUtils.damp(objData.zoomT, targetZoomT, 7, delta);

      if (objData.zoomT > 0.0001) {
        // Target position: center of screen, a fixed distance in front of camera
        camera.getWorldDirection(tempDir); // forward (-Z)
        tempTargetWorld.copy(camera.position).add(tempDir.multiplyScalar(FOCUS_DISTANCE));
        tempTargetLocal.copy(tempTargetWorld);
        groupRef.current!.worldToLocal(tempTargetLocal);

        // Blend position (local)
        group.position.lerpVectors(objData.currentPos, tempTargetLocal, objData.zoomT);

        // Blend rotation to face camera (copy camera quaternion)
        tempNormalQuat.copy(group.quaternion);
        tempTargetQuat.copy(camera.quaternion);
        group.quaternion.slerpQuaternions(tempNormalQuat, tempTargetQuat, objData.zoomT);

        // Ensure focused photo renders on top (avoid sparkles overlay)
        group.renderOrder = 1000;
        group.traverse((o) => {
          o.renderOrder = 1000;
          const mat: any = (o as any).material;
          if (mat) {
            mat.depthTest = true;
          }
        });
      } else if (group.renderOrder !== 0) {
        group.renderOrder = 0;
      }

      // Blend scale
      const zoomFactor = 6.0;
      const base = objData.scale;
      const s = base * (1 + (zoomFactor - 1) * objData.zoomT);
      group.scale.lerp(tempScale.setScalar(s), 1 - Math.pow(0.001, delta)); // smoothing independent of fps
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => (
        <group
          key={i}
          scale={[obj.scale, obj.scale, obj.scale]}
          rotation={state === 'CHAOS' ? obj.chaosRotation : [0, 0, 0]}
          userData={{ isPhoto: true, photoIndex: i }}
        >
          {/* 正面 */}
          <group position={[0, 0, 0.015]}>
            <mesh geometry={photoGeometry} userData={{ isPhoto: true, photoIndex: i }}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]} userData={{ isPhoto: true, photoIndex: i }}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
          </group>
          {/* 背面 */}
          <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
            <mesh geometry={photoGeometry} userData={{ isPhoto: true, photoIndex: i }}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]} userData={{ isPhoto: true, photoIndex: i }}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.elements;
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.5, 16, 16), []);
  const caneGeometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const type = Math.floor(Math.random() * 3);
      let color; let scale = 1;
      if (type === 0) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.8 + Math.random() * 0.4; }
      else if (type === 1) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.6 + Math.random() * 0.4; }
      else { color = Math.random() > 0.5 ? CONFIG.colors.red : CONFIG.colors.white; scale = 0.7 + Math.random() * 0.3; }

      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { type, chaosPos, targetPos, color, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry, sphereGeometry, caneGeometry]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        let geometry; if (obj.type === 0) geometry = boxGeometry; else if (obj.type === 1) geometry = sphereGeometry; else geometry = caneGeometry;
        return ( <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={geometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={obj.color} roughness={0.3} metalness={0.4} emissive={obj.color} emissiveIntensity={0.2} />
        </mesh> )})}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: CONFIG.colors.gold,
    emissive: CONFIG.colors.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};

// --- Main Scene Experience ---
const Experience = ({
  sceneState,
  rotationSpeed,
  pinchActive,
}: {
  sceneState: 'CHAOS' | 'FORMED';
  rotationSpeed: number;
  pinchActive: boolean;
}) => {
  const controlsRef = useRef<any>(null);
  const { scene, camera } = useThree();
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  const findClosestPhotoIndex = useCallback(() => {
    let bestIndex: number | null = null;
    let bestDist = Infinity;
    const worldPos = new THREE.Vector3();

    scene.traverse((obj) => {
      const ud = obj.userData as any;
      // Lấy group "cha" của polaroid (tránh các mesh con)
      if (ud?.isPhoto && typeof ud.photoIndex === 'number' && obj.type === 'Group' && obj.children.length >= 2) {
        obj.getWorldPosition(worldPos);
        const d = camera.position.distanceTo(worldPos);
        if (d < bestDist) {
          bestDist = d;
          bestIndex = ud.photoIndex;
        }
      }
    });

    return bestIndex;
  }, [scene, camera]);

  useEffect(() => {
    // “Chế độ mở” theo README = CHAOS (Open Palm). Chỉ cho pinch-zoom khi đang ở CHAOS.
    if (!pinchActive || sceneState !== 'CHAOS') {
      setZoomIndex(null);
      return;
    }
    const idx = findClosestPhotoIndex();
    setZoomIndex(idx);
  }, [pinchActive, sceneState, findClosestPhotoIndex]);

  const focusMode = pinchActive && sceneState === 'CHAOS' && zoomIndex !== null;

  const FocusBackdrop = ({ active }: { active: boolean }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const { camera, size } = useThree();
    const forward = useMemo(() => new THREE.Vector3(), []);
    const pos = useMemo(() => new THREE.Vector3(), []);

    useFrame(() => {
      if (!meshRef.current) return;
      if (!active) {
        meshRef.current.visible = false;
        return;
      }
      meshRef.current.visible = true;
      camera.getWorldDirection(forward);
      pos.copy(camera.position).add(forward.multiplyScalar(FOCUS_DISTANCE + 1));
      meshRef.current.position.copy(pos);
      meshRef.current.quaternion.copy(camera.quaternion);

      // scale plane to cover viewport at that distance
      const dist = FOCUS_DISTANCE + 1;
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
      const h = 2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)) * dist;
      const w = h * (size.width / size.height);
      meshRef.current.scale.set(w, h, 1);
    });

    return (
      <mesh ref={meshRef} renderOrder={900}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.55} depthTest={false} depthWrite={false} />
      </mesh>
    );
  };

  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + rotationSpeed);
      controlsRef.current.update();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 8, 60]} fov={45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={rotationSpeed === 0 && sceneState === 'FORMED'} autoRotateSpeed={0.3} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <Environment preset="night" background={false} />

      {/* Remove green tint: keep palette warm (gold/red) */}
      <ambientLight intensity={0.35} color="#220000" />
      <pointLight position={[30, 30, 30]} intensity={100} color={CONFIG.colors.warmLight} />
      <pointLight position={[-30, 10, -30]} intensity={50} color={CONFIG.colors.gold} />
      <pointLight position={[0, -20, 10]} intensity={30} color={CONFIG.colors.red} />

      <group position={[0, -6, 0]}>
        <Foliage state={sceneState} />
        <Suspense fallback={null}>
           <PhotoOrnaments state={sceneState} zoomIndex={zoomIndex} zoomActive={pinchActive && sceneState === 'CHAOS'} />
           <ChristmasElements state={sceneState} />
           <FairyLights state={sceneState} />
           <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={600} scale={50} size={8} speed={0.4} opacity={focusMode ? 0.05 : 0.4} color={CONFIG.colors.gold} />
      </group>

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={focusMode ? 0.6 : 1.5} radius={0.5} mipmapBlur />
        <Vignette eskil={false} offset={0.1} darkness={1.2} />
      </EffectComposer>

      {/* darken background during focus so the photo isn't "between sparkles" */}
      <FocusBackdrop active={focusMode} />
    </>
  );
};

// --- Gesture Controller ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GestureController = ({ onGesture, onMove, onStatus, onPinch, debugMode, sceneState }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handHistoryRef = useRef<Array<{ x: number; timestamp: number }>>([]);
  const momentumRef = useRef(0); // Tốc độ quán tính
  const lastUpdateTimeRef = useRef(Date.now());
  const pinchRef = useRef(false);
  const sceneStateRef = useRef(sceneState);
  const debugModeRef = useRef(debugMode);
  const onGestureRef = useRef(onGesture);
  const onMoveRef = useRef(onMove);
  const onStatusRef = useRef(onStatus);
  const onPinchRef = useRef(onPinch);

  // Keep latest props in refs to avoid re-creating the whole MediaPipe pipeline on each render
  useEffect(() => { sceneStateRef.current = sceneState; }, [sceneState]);
  useEffect(() => { debugModeRef.current = debugMode; }, [debugMode]);
  useEffect(() => { onGestureRef.current = onGesture; }, [onGesture]);
  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  useEffect(() => { onPinchRef.current = onPinch; }, [onPinch]);

  useEffect(() => {
    let gestureRecognizer: GestureRecognizer;
    let requestRef: number;

    const setup = async () => {
      onStatusRef.current?.("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });
        onStatusRef.current?.("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
            onStatusRef.current?.("AI READY: SHOW HAND");
            predictWebcam();
          }
        } else {
            onStatusRef.current?.("ERROR: CAMERA PERMISSION DENIED");
        }
      } catch (err: any) {
        onStatusRef.current?.(`ERROR: ${err.message || 'MODEL FAILED'}`);
      }
    };

    const predictWebcam = () => {
      if (gestureRecognizer && videoRef.current && canvasRef.current) {
        if (videoRef.current.videoWidth > 0) {
            const results = gestureRecognizer.recognizeForVideo(videoRef.current, Date.now());
            const ctx = canvasRef.current.getContext("2d");
            const currentTime = Date.now();
            lastUpdateTimeRef.current = currentTime;
            
            if (ctx && debugModeRef.current) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                canvasRef.current.width = videoRef.current.videoWidth; canvasRef.current.height = videoRef.current.videoHeight;
                if (results.landmarks) for (const landmarks of results.landmarks) {
                        const drawingUtils = new DrawingUtils(ctx);
                        drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 });
                        drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 });
                }
            } else if (ctx && !debugModeRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

            // Luôn luôn giảm dần momentum (ma sát/quán tính)
            const friction = 0.95; // Hệ số ma sát (0.95 = giảm 5% mỗi frame)
            momentumRef.current *= friction;
            
            // Nếu momentum quá nhỏ, đặt về 0
            if (Math.abs(momentumRef.current) < 0.001) {
              momentumRef.current = 0;
            }

            if (results.gestures.length > 0) {
              const name = results.gestures[0][0].categoryName; const score = results.gestures[0][0].score;
              if (score > 0.4) {
                 if (name === "Open_Palm") onGestureRef.current?.("CHAOS"); if (name === "Closed_Fist") onGestureRef.current?.("FORMED");
                 if (debugModeRef.current) onStatusRef.current?.(`DETECTED: ${name}`);
              }
              
              // Phát hiện chuyển động vẫy tay
              if (results.landmarks.length > 0) {
                const wristX = results.landmarks[0][0].x; // Vị trí x của cổ tay
                const history = handHistoryRef.current;
                
                // Thêm vị trí hiện tại vào lịch sử
                history.push({ x: wristX, timestamp: currentTime });
                
                // Chỉ giữ lịch sử trong 300ms (ngắn hơn để phản ứng nhanh hơn)
                const timeWindow = 300;
                handHistoryRef.current = history.filter(h => currentTime - h.timestamp < timeWindow);
                
                // Tính toán vận tốc nếu có đủ dữ liệu
                if (history.length >= 2) {
                  const recentHistory = handHistoryRef.current;
                  if (recentHistory.length >= 2) {
                    const oldest = recentHistory[0];
                    const newest = recentHistory[recentHistory.length - 1];
                    const timeDiff = newest.timestamp - oldest.timestamp;
                    
                    if (timeDiff > 30) { // Ít nhất 30ms để tính toán chính xác
                      const distance = newest.x - oldest.x;
                      const velocity = distance / timeDiff; // Vận tốc (pixels/ms)
                      
                      // Chuyển đổi vận tốc thành tốc độ xoay
                      // Vẫy sang phải (x tăng) = xoay dương, vẫy sang trái (x giảm) = xoay âm
                      const rotationSpeed = velocity * 1000; // Hệ số điều chỉnh độ nhạy
                      
                      // Giới hạn tốc độ xoay tối đa
                      const clampedSpeed = Math.max(-1.0, Math.min(1.0, rotationSpeed));
                      
                      // Nếu có chuyển động đáng kể, cập nhật momentum
                      if (Math.abs(clampedSpeed) > 0.03) {
                        // Cộng dồn momentum (cho phép tích lũy khi hất tay nhanh)
                        momentumRef.current = clampedSpeed * 0.8 + momentumRef.current * 0.2;
                        
                        if (debugModeRef.current) {
                          const direction = clampedSpeed > 0 ? "RIGHT" : "LEFT";
                          onStatusRef.current?.(`WAVING ${direction}: ${momentumRef.current.toFixed(3)}`);
                        }
                      }
                    }
                  }
                }
              }
            } else {
              // Không có bàn tay, nhưng momentum vẫn tiếp tục
              handHistoryRef.current = []; // Xóa lịch sử
              if (debugModeRef.current && Math.abs(momentumRef.current) > 0.01) {
                onStatusRef.current?.(`MOMENTUM: ${momentumRef.current.toFixed(3)}`);
              } else if (debugModeRef.current) {
                onStatusRef.current?.("AI READY: NO HAND");
              }
            }

            // Pinch detection (thumb tip 4 + index tip 8). Chỉ kích hoạt khi đang ở "mở" (CHAOS).
            // Thêm hysteresis để tránh nhấp nháy.
            const allowPinch = sceneStateRef.current === 'CHAOS';
            let nextPinch = false;
            if (allowPinch && results.landmarks && results.landmarks.length > 0) {
              const lm = results.landmarks[0];
              const thumbTip = lm[4];
              const indexTip = lm[8];
              if (thumbTip && indexTip) {
                const dx = thumbTip.x - indexTip.x;
                const dy = thumbTip.y - indexTip.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const pinchOn = 0.045;
                const pinchOff = 0.065;
                if (pinchRef.current) {
                  nextPinch = dist < pinchOff;
                } else {
                  nextPinch = dist < pinchOn;
                }
              }
            }

            if (nextPinch !== pinchRef.current) {
              pinchRef.current = nextPinch;
              onPinchRef.current?.(nextPinch);
              if (debugModeRef.current) onStatusRef.current?.(nextPinch ? "PINCH: ZOOM IN" : "PINCH: ZOOM OUT");
            }
            
            // Luôn luôn áp dụng momentum vào xoay
            onMoveRef.current?.(momentumRef.current);
        }
        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup();
    return () => {
      cancelAnimationFrame(requestRef);
      handHistoryRef.current = [];
      momentumRef.current = 0;
      lastUpdateTimeRef.current = Date.now();
      pinchRef.current = false;
      onPinchRef.current?.(false);
    };
  }, []);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>('CHAOS');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [pinchActive, setPinchActive] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const audioLoadedRef = useRef(false);
  const pendingAutoStartRef = useRef(false);
  const soundEnabledRef = useRef(true);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    // expects file at: public/sounds/sound.mp3 -> URL: /sounds/sound.mp3
    const audio = new Audio('/sounds/sound.mp3');
    audio.preload = 'auto';
    audio.volume = 0.7;
    audio.loop = true;
    audioRef.current = audio;

    const onCanPlayThrough = () => {
      audioLoadedRef.current = true;
      // If user already interacted (unlocked) and sound is enabled, start immediately.
      if (soundEnabledRef.current && audioUnlockedRef.current) {
        audio.play().catch(() => {
          pendingAutoStartRef.current = true;
        });
      } else if (soundEnabledRef.current) {
        // Try autoplay; if blocked, queue for first user gesture.
        audio.play()
          .then(() => {
            audioUnlockedRef.current = true;
          })
          .catch(() => {
            pendingAutoStartRef.current = true;
          });
      }
    };

    audio.addEventListener('canplaythrough', onCanPlayThrough);
    return () => {
      audio.removeEventListener('canplaythrough', onCanPlayThrough);
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  const startSound = useCallback(async () => {
    if (audioUnlockedRef.current) return true;
    const a = audioRef.current;
    if (!a) return false;
    try {
      // Attempt to start (also unlocks on user gesture). Do NOT reset currentTime.
      await a.play();
      audioUnlockedRef.current = true;
      return true;
    } catch {
      pendingAutoStartRef.current = true;
      return false;
    }
  }, []);

  useEffect(() => {
    if (!soundEnabled) return;
    const onFirstGesture = async () => {
      const ok = await startSound();
      if (ok && pendingAutoStartRef.current && audioLoadedRef.current) {
        pendingAutoStartRef.current = false;
        audioRef.current?.play().catch(() => {
          // ignore
        });
      }
    };
    window.addEventListener('pointerdown', onFirstGesture, { passive: true });
    window.addEventListener('keydown', onFirstGesture);
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
  }, [soundEnabled, startSound]);

  // Pause/resume without restarting when toggling SOUND ON/OFF
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!soundEnabled) {
      a.pause();
      return;
    }
    // If already unlocked, resume; otherwise will start on next user gesture.
    if (audioUnlockedRef.current) {
      a.play().catch(() => {
        // ignore
      });
    } else if (audioLoadedRef.current) {
      // If loaded but not unlocked yet, attempt autoplay (may be blocked)
      a.play()
        .then(() => {
          audioUnlockedRef.current = true;
          pendingAutoStartRef.current = false;
        })
        .catch(() => {
          pendingAutoStartRef.current = true;
        });
    }
  }, [soundEnabled]);

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas dpr={[1, 2]} gl={{ toneMapping: THREE.ReinhardToneMapping }} shadows>
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} pinchActive={pinchActive} />
        </Canvas>
      </div>
      <GestureController
        onGesture={setSceneState}
        onMove={setRotationSpeed}
        onStatus={setAiStatus}
        onPinch={setPinchActive}
        debugMode={debugMode}
        sceneState={sceneState}
      />

      {/* UI - Stats */}
      <div style={{ position: 'absolute', bottom: '30px', left: '40px', color: '#888', zIndex: 10, fontFamily: 'sans-serif', userSelect: 'none' }}>
        <div style={{ marginBottom: '15px' }}>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Memories</p>
          <p style={{ fontSize: '24px', color: '#FFD700', fontWeight: 'bold', margin: 0 }}>
            {CONFIG.counts.ornaments.toLocaleString()} <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>POLAROIDS</span>
          </p>
        </div>
        <div>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Foliage</p>
          <p style={{ fontSize: '24px', color: '#004225', fontWeight: 'bold', margin: 0 }}>
            {(CONFIG.counts.foliage / 1000).toFixed(0)}K <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>EMERALD NEEDLES</span>
          </p>
        </div>
      </div>

      {/* UI - Buttons */}
      <div style={{ position: 'absolute', bottom: '30px', right: '40px', zIndex: 10, display: 'flex', gap: '10px' }}>
        <button
          onClick={async () => {
            const next = !soundEnabled;
            setSoundEnabled(next);
            // try to start immediately on this user gesture
            if (next) await startSound();
          }}
          style={{
            padding: '12px 15px',
            backgroundColor: soundEnabled ? '#FFD700' : 'rgba(0,0,0,0.5)',
            border: '1px solid #FFD700',
            color: soundEnabled ? '#000' : '#FFD700',
            fontFamily: 'sans-serif',
            fontSize: '12px',
            fontWeight: 'bold',
            cursor: 'pointer',
            backdropFilter: 'blur(4px)'
          }}
        >
          {soundEnabled ? 'SOUND ON' : 'SOUND OFF'}
        </button>
        <button onClick={() => setDebugMode(!debugMode)} style={{ padding: '12px 15px', backgroundColor: debugMode ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: debugMode ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {debugMode ? 'HIDE DEBUG' : '🛠 DEBUG'}
        </button>
        <button onClick={() => setSceneState(s => s === 'CHAOS' ? 'FORMED' : 'CHAOS')} style={{ padding: '12px 30px', backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255, 215, 0, 0.5)', color: '#FFD700', fontFamily: 'serif', fontSize: '14px', fontWeight: 'bold', letterSpacing: '3px', textTransform: 'uppercase', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {sceneState === 'CHAOS' ? 'Assemble Tree' : 'Disperse'}
        </button>
      </div>

      {/* UI - AI Status */}
      <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', color: aiStatus.includes('ERROR') ? '#FF0000' : 'rgba(255, 215, 0, 0.4)', fontSize: '10px', letterSpacing: '2px', zIndex: 10, background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>
        {aiStatus}
      </div>
    </div>
  );
}