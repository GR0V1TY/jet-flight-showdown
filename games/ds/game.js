/* =========================================================================
   SKYBREAKER — 写实喷气机飞行模拟小游戏
   渲染: three.js r128 (UMD)
   结构:  Core(纯数学/物理, 可在 node 中测试)  ->  World(场景)  ->  Game(玩法)
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
     1. CORE — 噪声 / 地形 / 飞行物理（与 DOM 无关，可单测）
     --------------------------------------------------------------------- */
  var Core = (function () {
    var TN = (typeof THREE !== 'undefined') ? THREE : null;

    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function smoothstep(t) { return t * t * (3 - 2 * t); }

    /* --- 值噪声 + fBm --- */
    function hash2(x, y) {
      var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return n - Math.floor(n);
    }
    function vnoise(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      var u = smoothstep(xf), v = smoothstep(yf);
      var a = hash2(xi, yi), b = hash2(xi + 1, yi);
      var c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
      return lerp(lerp(a, b, u), lerp(c, d, u), v);
    }
    function fbm(x, y, oct) {
      oct = oct || 4;
      var s = 0, amp = 0.5, f = 1, norm = 0;
      for (var i = 0; i < oct; i++) {
        s += vnoise(x * f, y * f) * amp;
        norm += amp; amp *= 0.5; f *= 2.03;
      }
      return s / norm;
    }

    /* --- 地形高度场（单位: 米）--- */
    function terrainHeight(x, z) {
      var wx = x + 900 * (fbm(x * 0.00017 + 13.7, z * 0.00017 - 4.2, 2) - 0.5);
      var wz = z + 900 * (fbm(x * 0.00017 - 7.1, z * 0.00017 + 9.4, 2) - 0.5);

      var cont = fbm(wx * 0.00013, wz * 0.00013, 3);           // 大陆/海洋
      var h = (cont - 0.38) * 980;                              // 基底
      var ridge = 1 - Math.abs(fbm(wx * 0.00042, wz * 0.00042, 4) - 0.5) * 2; // 山脊 0..1
      var mask = clamp((cont - 0.38) * 3.4, 0, 1);
      h += Math.pow(ridge, 2.2) * 1100 * mask;                  // 山脉
      h += (fbm(wx * 0.0021, wz * 0.0021, 3) - 0.5) * 68;        // 丘陵起伏
      h += (fbm(wx * 0.0092, wz * 0.0092, 2) - 0.5) * 9;         // 细节

      // 地图外圈沉入海面，避免出现地形硬边缘
      var r = Math.sqrt(x * x + z * z);
      if (r > 8800) {
        var e = clamp((r - 8800) / 3200, 0, 1);
        h = h * (1 - e * e) - e * e * 760;
      }
      return h;
    }
    function groundHeight(x, z) { return Math.max(terrainHeight(x, z), 0); }

    /* --- 飞行参数 --- */
    var P = {
      mass: 900,          // kg
      wingArea: 6.0,      // m^2 (等效升力面积, 已调校)
      rho0: 1.225,
      g: 9.81,
      thrustMax: 4600,    // N
      abFactor: 1.85,     // 加力
      cd0: 0.030,
      kInduced: 0.045,
      cl0: 0.050,
      clSlope: 4.2,
      clMax: 1.05,
      stallAlpha: 0.28,
      pitchRate: 0.78,    // rad/s
      rollRate: 2.50,
      yawRate: 0.40,
      gLimit: 9.0,
      maxSpeed: 300
    };

    function createState() {
      return {
        pos: new TN.Vector3(0, 320, 300),
        vel: new TN.Vector3(0, 0, -120),
        quat: new TN.Quaternion(),
        rates: new TN.Vector3(0, 0, 0),  // x=pitch(抬头+) y=yaw(左转+) z=roll(左滚+)
        throttle: 0.55,
        speed: 120,
        alpha: 0,
        beta: 0,
        gForce: 1,
        stall: 0,
        thrust: 0,
        bank: 0
      };
    }

    var _v1 = new TN.Vector3(), _v2 = new TN.Vector3(), _v3 = new TN.Vector3(),
        _v4 = new TN.Vector3(), _v5 = new TN.Vector3(), _v6 = new TN.Vector3(),
        _v7 = new TN.Vector3(), _a1 = new TN.Vector3(),
        _q1 = new TN.Quaternion(), _dq = new TN.Quaternion(),
        _e1 = new TN.Euler(), _e2 = new TN.Euler();

    /**
     * 推进一帧飞行物理
     * ctrl: { pitch:-1..1(抬头+) roll:-1..1(右滚+) yaw:-1..1(右舵+) throttle:0..1 boost:bool }
     */
    function stepFlight(st, ctrl, dt) {
      if (!(dt > 0)) return st;
      dt = Math.min(dt, 0.05);

      /* --- 油门（有惯性，不能瞬间到位）--- */
      var tgt = clamp(ctrl.throttle, 0, 1);
      var tRate = (tgt > st.throttle) ? 0.62 : 0.80;
      st.throttle += clamp(tgt - st.throttle, -dt * tRate, dt * tRate);
      st.throttle = clamp(st.throttle, 0, 1);

      var speed = st.vel.length();
      var fwd = _v1.set(0, 0, -1).applyQuaternion(st.quat);
      var up = _v2.set(0, 1, 0).applyQuaternion(st.quat);
      var right = _v3.set(1, 0, 0).applyQuaternion(st.quat);

      var velDir = (speed > 0.5) ? _v4.copy(st.vel).divideScalar(speed) : _v4.copy(fwd);

      /* --- 机体坐标下的来流 => 迎角 / 侧滑角 --- */
      _q1.copy(st.quat).invert();
      var vLocal = _v5.copy(st.vel).applyQuaternion(_q1);
      var fz = Math.max(-vLocal.z, 0.001);
      var alpha = Math.atan2(-vLocal.y, fz);
      var beta = Math.atan2(vLocal.x, fz);
      st.alpha = alpha; st.beta = beta;

      var rho = P.rho0 * Math.exp(-Math.max(0, st.pos.y) / 9000);
      var qdyn = 0.5 * rho * speed * speed;

      /* --- 操纵：舵效随速度下降（低速"面糊"）--- */
      var authority = clamp(speed / 95, 0.10, 1.15);
      var resp = 1 - Math.exp(-dt * 8);

      _e1.setFromQuaternion(st.quat, 'YXZ');
      var bank = _e1.z;
      st.bank = bank;

      /* 配平迎角：让松杆时飞机会自持平飞（与真实飞机的配平片同理） */
      var alphaTrim = clamp((P.mass * P.g / Math.max(qdyn * P.wingArea, 1) - P.cl0) / P.clSlope, -0.03, 0.15);
      var handsOff = 1 - Math.min(1, Math.abs(ctrl.pitch));

      var pitchCmd = ctrl.pitch * P.pitchRate * authority
        - (alpha - alphaTrim) * 1.35 * handsOff * clamp(speed / 80, 0, 1);
      var yawCmd = -ctrl.yaw * P.yawRate * authority
        - beta * 2.0 * clamp(speed / 70, 0, 1);
      var rollCmd = -ctrl.roll * P.rollRate * clamp(speed / 55, 0.12, 1);
      if (Math.abs(ctrl.roll) < 0.08) rollCmd += -Math.sin(bank) * 0.25 * clamp(speed / 85, 0, 1);

      st.rates.x += (pitchCmd - st.rates.x) * resp;
      st.rates.y += (yawCmd - st.rates.y) * resp;
      st.rates.z += (rollCmd - st.rates.z) * resp;

      _e2.set(st.rates.x * dt, st.rates.y * dt, st.rates.z * dt, 'YXZ');
      _dq.setFromEuler(_e2);
      st.quat.multiply(_dq).normalize();

      /* --- 气动力 --- */
      var q = qdyn;
      var cl = P.cl0 + P.clSlope * alpha;
      var stallF = 0;
      var over = Math.abs(alpha) - P.stallAlpha;
      if (over > 0) {
        stallF = clamp(over / 0.45, 0, 1);
        cl *= (1 - 0.9 * stallF);
      }
      cl = clamp(cl, -P.clMax, P.clMax);
      st.stall = stallF;

      var liftDir = _v6.copy(up).addScaledVector(velDir, -up.dot(velDir));
      if (liftDir.lengthSq() < 1e-5) liftDir.copy(up);
      liftDir.normalize();

      var maxForce = P.gLimit * P.mass * P.g;
      var lift = clamp(q * P.wingArea * cl, -maxForce, maxForce);
      var cd = P.cd0 + P.kInduced * cl * cl + stallF * 0.20;
      var drag = q * P.wingArea * cd;
      var side = clamp(-beta * q * P.wingArea * 1.2, -maxForce, maxForce);

      var abOn = !!ctrl.boost && st.throttle > 0.55;
      var thrust = st.throttle * P.thrustMax * (abOn ? P.abFactor : 1)
        * (1 - clamp(st.pos.y / 22000, 0, 0.35));
      st.thrust = thrust;
      st.abOn = abOn;

      /* --- 合力 --- */
      _a1.set(0, 0, 0);
      _a1.addScaledVector(fwd, thrust / P.mass);
      _a1.addScaledVector(liftDir, lift / P.mass);
      _a1.addScaledVector(velDir, -drag / P.mass);
      _a1.addScaledVector(right, side / P.mass);

      var ngx = _a1.x, ngy = _a1.y, ngz = _a1.z;   // 非重力加速度
      st.gForce = Math.sqrt(ngx * ngx + ngy * ngy + ngz * ngz) / P.g;

      _a1.y -= P.g;

      st.vel.addScaledVector(_a1, dt);
      speed = st.vel.length();
      if (speed > P.maxSpeed) st.vel.multiplyScalar(P.maxSpeed / speed);
      st.pos.addScaledVector(st.vel, dt);
      st.speed = st.vel.length();
      return st;
    }

    return {
      clamp: clamp, lerp: lerp, fbm: fbm, vnoise: vnoise,
      terrainHeight: terrainHeight, groundHeight: groundHeight,
      P: P, createState: createState, stepFlight: stepFlight
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined') return;   // —— node 测试到此为止 ——

  var C = Core;
  var clamp = C.clamp, lerp = C.lerp;

  /* ---------------------------------------------------------------------
     2. 基础常量
     --------------------------------------------------------------------- */
  var WORLD = {
    terrainSize: 24000,
    terrainSeg: 262,
    fogColor: 0xb7cee6,
    fogDensity: 0.000108,
    waterLevel: 0,
    ringRadius: 48,
    ringCount: 8,
    spawn: new THREE.Vector3(-4750, 724, 5250)
  };

  var SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(64), THREE.MathUtils.degToRad(152)).normalize();
  // 仰角 = 90-64=26°

  /* ---------------------------------------------------------------------
     3. DOM
     --------------------------------------------------------------------- */
  var canvas = document.getElementById('scene');
  var ui = {
    loading: document.getElementById('loading'),
    start: document.getElementById('startScreen'),
    over: document.getElementById('overScreen'),
    pause: document.getElementById('pauseScreen'),
    hud: document.getElementById('hud'),
    score: document.getElementById('vScore'),
    rings: document.getElementById('vRings'),
    dist: document.getElementById('vDist'),
    spd: document.getElementById('vSpeed'),
    alt: document.getElementById('vAlt'),
    vs: document.getElementById('vVS'),
    thr: document.getElementById('vThr'),
    thrBar: document.getElementById('thrBar'),
    g: document.getElementById('vG'),
    tgtDist: document.getElementById('vTgtDist'),
    arrow: document.getElementById('tgtArrow'),
    marker: document.getElementById('velMarker'),
    cross: document.getElementById('crosshair'),
    att: document.getElementById('attitude'),
    attInner: document.getElementById('attInner'),
    warn: document.getElementById('warn'),
    finalScore: document.getElementById('finalScore'),
    finalRings: document.getElementById('finalRings'),
    finalDist: document.getElementById('finalDist'),
    best: document.getElementById('bestScore'),
    btnStart: document.getElementById('btnStart'),
    btnAgain: document.getElementById('btnAgain'),
    btnResume: document.getElementById('btnResume'),
    btnMouse: document.getElementById('btnMouse'),
    mouseTag: document.getElementById('mouseTag'),
    flash: document.getElementById('flash'),
    toast: document.getElementById('toast')
  };

  /* ---------------------------------------------------------------------
     4. 渲染器 / 场景
     --------------------------------------------------------------------- */
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, powerPreference: 'high-performance', stencil: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(WORLD.fogColor, WORLD.fogDensity);
  // 雾色与天空地平线保持同一线性值，远景才能无缝融入天际
  scene.fog.color.setRGB(0.3011, 0.4447, 0.6204);

  var camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 1, 46000);
  camera.position.set(0, 340, 560);

  /* ---------- 4.1 环境贴图（用等距柱状渐变生成 PMREM） ---------- */
  function buildEnvironment() {
    var cnv = document.createElement('canvas');
    cnv.width = 512; cnv.height = 256;
    var ctx = cnv.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#2d6ba8');
    g.addColorStop(0.35, '#6ea3d4');
    g.addColorStop(0.49, '#cfdfee');
    g.addColorStop(0.51, '#8d9096');
    g.addColorStop(1.00, '#3b3a34');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 256);

    // 太阳亮斑（等距柱状投影：经度由方位角决定）
    var sx = ((SUN_DIR.x * 0.5 + 0.5) * 512);
    var sy = ((0.5 - Math.asin(clamp(SUN_DIR.y, -1, 1)) / Math.PI) * 256);
    var rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 46);
    rg.addColorStop(0, 'rgba(255,250,235,1)');
    rg.addColorStop(0.25, 'rgba(255,238,205,0.75)');
    rg.addColorStop(1, 'rgba(255,235,200,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(sx, sy, 46, 0, Math.PI * 2); ctx.fill();

    var tex = new THREE.CanvasTexture(cnv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.encoding = THREE.sRGBEncoding;
    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var rt = pmrem.fromEquirectangular(tex);
    scene.environment = rt.texture;
    tex.dispose();
    pmrem.dispose();
  }
  buildEnvironment();

  /* ---------- 4.2 天空穹顶 ---------- */
  // 线性空间颜色：经 uExposure -> ACES -> sRGB 后渲染为设计色
  var SKY_LIN = {
    top: [0.0222, 0.0697, 0.1691],      // 天顶  #2f6fae
    mid: [0.0687, 0.1438, 0.3360],      // 中层  #6ea3d4
    horizon: [0.3011, 0.4447, 0.6204],  // 地平  #cfdfe9
    ground: [0.1057, 0.1101, 0.1197],   // 地平以下雾霭
    sun: [4.2598, 1.0127, 0.3693]
  };
  function linColor(a) { return new THREE.Color().setRGB(a[0], a[1], a[2]); }

  var skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: linColor(SKY_LIN.top) },
      uMid: { value: linColor(SKY_LIN.mid) },
      uHorizon: { value: linColor(SKY_LIN.horizon) },
      uGround: { value: linColor(SKY_LIN.ground) },
      uSun: { value: SUN_DIR.clone() },
      uSunColor: { value: linColor(SKY_LIN.sun) },
      uExposure: { value: 1.02 }
    },
    vertexShader: [
      'varying vec3 vDir;',
      'void main(){',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vDir = wp.xyz - cameraPosition;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uTop, uMid, uHorizon, uGround, uSunColor, uSun;',
      'uniform float uExposure;',
      'varying vec3 vDir;',
      'void main(){',
      '  vec3 d = normalize(vDir);',
      '  float h = d.y;',
      '  vec3 col;',
      '  if (h >= 0.0) {',
      '    vec3 low = mix(uHorizon, uMid, smoothstep(0.0, 0.20, h));',
      '    col = mix(low, uTop, smoothstep(0.10, 0.92, pow(max(h, 0.0), 0.55)));',
      '  } else {',
      '    col = mix(uHorizon, uGround, smoothstep(0.0, 0.30, -h));',
      '  }',
      '  float sd = max(dot(d, normalize(uSun)), 0.0);',
      '  col += uSunColor * pow(sd, 1500.0) * 8.0;',
      '  col += uSunColor * pow(sd, 30.0) * 0.16;',
      '  col += uSunColor * pow(sd, 4.0) * 0.04;',
      // 与 three 的 ACESFilmic + sRGB 输出保持一致
      '  vec3 c = col * uExposure / 0.6;',
      '  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);',
      '  c = mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'
    ].join('\n')
  });
  var skyDome = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 20), skyMat);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -10;
  scene.add(skyDome);

  /* ---------- 4.3 灯光 ---------- */
  var sunLight = new THREE.DirectionalLight(0xfff2df, 2.35);
  sunLight.position.copy(SUN_DIR).multiplyScalar(8000);
  scene.add(sunLight);

  var hemi = new THREE.HemisphereLight(0xa9c8ea, 0x4a4438, 0.55);
  scene.add(hemi);

  var fill = new THREE.DirectionalLight(0xbdd6f0, 0.35);
  fill.position.set(-SUN_DIR.x * 4000, 2000, -SUN_DIR.z * 4000);
  scene.add(fill);

  /* ---------- 4.4 地形 ---------- */
  function buildTerrain() {
    var size = WORLD.terrainSize, seg = WORLD.terrainSeg;
    var geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    var pos = geo.attributes.position;
    var i, x, z, y;
    for (i = 0; i < pos.count; i++) {
      x = pos.getX(i); z = pos.getZ(i);
      y = C.terrainHeight(x, z);
      pos.setY(i, y);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    var nrm = geo.attributes.normal;
    var colors = new Float32Array(pos.count * 3);
    var c = new THREE.Color();
    for (i = 0; i < pos.count; i++) {
      x = pos.getX(i); z = pos.getZ(i); y = pos.getY(i);
      var ny = nrm.getY(i);
      var n = C.fbm(x * 0.0013, z * 0.0013, 2);
      var n2 = C.fbm(x * 0.011, z * 0.011, 2);

      if (y < 1.5) {
        // 沙滩 / 水下
        c.setRGB(0.62, 0.57, 0.44);
      } else if (y < 160) {
        var t = (y - 1.5) / 158;
        c.setRGB(
          lerp(0.30 + n * 0.10, 0.19 + n2 * 0.07, t),
          lerp(0.36 + n * 0.10, 0.26 + n2 * 0.07, t),
          lerp(0.17 + n * 0.06, 0.15 + n2 * 0.05, t)
        );
      } else if (y < 520) {
        var t2 = (y - 160) / 360;
        c.setRGB(
          lerp(0.19 + n2 * 0.07, 0.33 + n2 * 0.10, t2),
          lerp(0.26 + n2 * 0.07, 0.30 + n2 * 0.09, t2),
          lerp(0.15 + n2 * 0.05, 0.27 + n2 * 0.08, t2)
        );
      } else {
        var t3 = clamp((y - 520) / 260, 0, 1);
        c.setRGB(
          lerp(0.33, 0.86, t3),
          lerp(0.30, 0.88, t3),
          lerp(0.27, 0.92, t3)
        );
      }

      // 陡坡露岩
      if (ny < 0.80 && y > 2) {
        var rk = clamp((0.80 - ny) / 0.35, 0, 1) * 0.85;
        c.r = lerp(c.r, 0.30 + n2 * 0.10, rk);
        c.g = lerp(c.g, 0.27 + n2 * 0.09, rk);
        c.b = lerp(c.b, 0.24 + n2 * 0.08, rk);
      }
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.02, envMapIntensity: 0.65
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  }
  var terrain = buildTerrain();

  /* ---------- 4.5 海面 ---------- */
  function buildWater() {
    var geo = new THREE.PlaneGeometry(70000, 70000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    var mat = new THREE.MeshStandardMaterial({
      color: 0x1d4a63, roughness: 0.14, metalness: 0.62, envMapIntensity: 1.35
    });
    var m = new THREE.Mesh(geo, mat);
    m.position.y = WORLD.waterLevel;
    scene.add(m);
    return m;
  }
  var water = buildWater();

  /* ---------- 4.6 云层 ---------- */
  function cloudTexture() {
    var s = 256;
    var cnv = document.createElement('canvas');
    cnv.width = cnv.height = s;
    var ctx = cnv.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    for (var i = 0; i < 16; i++) {
      var a = Math.random() * Math.PI * 2;
      var rr = Math.random() * s * 0.22;
      var px = s / 2 + Math.cos(a) * rr;
      var py = s / 2 + Math.sin(a) * rr * 0.62;
      var rad = s * (0.13 + Math.random() * 0.16);
      var g = ctx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.42)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
    }
    var t = new THREE.CanvasTexture(cnv);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  var cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  function buildClouds() {
    var tex = cloudTexture();
    var CLUSTERS = 40;
    for (var i = 0; i < CLUSTERS; i++) {
      var ang = Math.random() * Math.PI * 2;
      var rad = 400 + Math.random() * 9200;
      var cx = Math.cos(ang) * rad;
      var cz = Math.sin(ang) * rad;
      var cy = 620 + Math.random() * 1250;
      var dir = (Math.random() - 0.5) * Math.PI;

      var puffs = 5 + Math.floor(Math.random() * 5);
      var baseSize = 320 + Math.random() * 520;
      var tint = 0.86 + Math.random() * 0.14;

      for (var j = 0; j < puffs; j++) {
        var m = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          opacity: 0.62 + Math.random() * 0.3,
          color: new THREE.Color(tint, tint, tint * 1.02),
          fog: true
        });
        var sp = new THREE.Sprite(m);
        var ox = (Math.random() - 0.5) * baseSize * 2.4;
        var oz = (Math.random() - 0.5) * baseSize * 1.7;
        sp.position.set(
          cx + Math.cos(dir) * ox - Math.sin(dir) * oz,
          cy + (Math.random() - 0.5) * baseSize * 0.5,
          cz + Math.sin(dir) * ox + Math.cos(dir) * oz
        );
        var sc = baseSize * (0.55 + Math.random() * 0.75);
        sp.scale.set(sc, sc * (0.52 + Math.random() * 0.25), 1);
        sp.renderOrder = 2;
        cloudGroup.add(sp);
      }
    }
  }
  buildClouds();

  /* ---------- 4.7 岩柱障碍 ---------- */
  var spires = [];
  function buildSpires() {
    var geo = new THREE.ConeGeometry(1, 1, 7, 1, false);
    geo.translate(0, 0.5, 0);
    // 让锥体顶点带一点不规则
    var pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i);
      if (y > 0.5) {
        pos.setX(i, pos.getX(i) * (0.2 + Math.random() * 0.3));
        pos.setZ(i, pos.getZ(i) * (0.2 + Math.random() * 0.3));
      }
    }
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      color: 0x54514a, roughness: 0.96, metalness: 0.02, envMapIntensity: 0.5
    });

    var n = 88;
    for (var k = 0; k < n; k++) {
      var a = Math.random() * Math.PI * 2;
      var r = 900 + Math.random() * 7200;
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      // 出生点附近留出空域
      if (Math.hypot(x - WORLD.spawn.x, z - WORLD.spawn.z) < 900) continue;
      var gh = C.terrainHeight(x, z);
      if (gh < 3) continue;
      var radius = 34 + Math.random() * 62;
      var height = 220 + Math.random() * 460;
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x, gh - 12, z);
      m.scale.set(radius, height, radius);
      m.rotation.y = Math.random() * Math.PI;
      scene.add(m);
      spires.push({ x: x, z: z, r: radius * 0.72, top: gh - 12 + height });
    }
  }
  buildSpires();

  /* ---------------------------------------------------------------------
     5. 飞机模型
     --------------------------------------------------------------------- */
  function buildJet() {
    var g = new THREE.Group();

    var bodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.86, roughness: 0.34, envMapIntensity: 1.1 });
    var bodyMat2 = new THREE.MeshStandardMaterial({ color: 0x7f8a94, metalness: 0.85, roughness: 0.42, envMapIntensity: 1.0 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2f35, metalness: 0.72, roughness: 0.44, envMapIntensity: 0.9 });
    var accentMat = new THREE.MeshStandardMaterial({ color: 0x8f2320, metalness: 0.45, roughness: 0.38, envMapIntensity: 1.0 });
    var glassMat = new THREE.MeshStandardMaterial({ color: 0x11202c, metalness: 1.0, roughness: 0.06, envMapIntensity: 2.0 });

    /* 机身：旋转体 */
    var prof = [
      [0.00, 0.00], [0.16, 0.55], [0.34, 1.30], [0.55, 2.35], [0.70, 3.60],
      [0.80, 5.20], [0.83, 7.20], [0.82, 9.20], [0.76, 10.90], [0.64, 12.30],
      [0.52, 13.30], [0.47, 13.80]
    ];
    var pts = prof.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var fusGeo = new THREE.LatheGeometry(pts, 26);
    fusGeo.rotateX(Math.PI / 2);      // +Y -> +Z, 机头(-Z)在 z=0
    fusGeo.translate(0, 0, -6.9);
    var fus = new THREE.Mesh(fusGeo, bodyMat);
    g.add(fus);

    /* 机背略带颜色的中段 */
    var spineGeo = new THREE.CylinderGeometry(0.30, 0.24, 6.0, 12, 1, true);
    spineGeo.rotateX(Math.PI / 2);
    var spine = new THREE.Mesh(spineGeo, bodyMat2);
    spine.position.set(0, 0.74, -1.6);
    spine.scale.set(1, 1, 1);
    g.add(spine);

    /* 机翼 */
    function makeWing(rootX, tipX, rootF, rootB, tipF, tipB, thick) {
      var s = new THREE.Shape();
      s.moveTo(rootX, rootF);
      s.lineTo(tipX, tipF);
      s.lineTo(tipX, tipB);
      s.lineTo(rootX, rootB);
      s.closePath();
      var geo = new THREE.ExtrudeGeometry(s, {
        depth: thick, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.05, bevelSegments: 1, curveSegments: 1
      });
      geo.rotateX(Math.PI / 2);
      return geo;
    }

    var wingGeo = makeWing(0.55, 5.6, -1.2, 3.5, 1.4, 2.9, 0.26);
    var wingR = new THREE.Mesh(wingGeo, bodyMat);
    wingR.position.y = 0.06;
    var wingL = new THREE.Mesh(wingGeo, bodyMat);
    wingL.scale.x = -1;
    wingL.position.y = 0.06;
    var wingMatL = bodyMat.clone(); wingMatL.side = THREE.DoubleSide;
    var wingMatR = bodyMat.clone(); wingMatR.side = THREE.DoubleSide;
    wingL.material = wingMatL; wingR.material = wingMatR;
    g.add(wingR); g.add(wingL);

    /* 前缘红色条 */
    var leGeo = new THREE.BoxGeometry(5.25, 0.07, 0.20);
    leGeo.rotateY(-0.515);
    var leR = new THREE.Mesh(leGeo, accentMat);
    leR.position.set(3.28, 0.19, 0.10);
    var leL = new THREE.Mesh(leGeo, accentMat);
    leL.scale.x = -1;
    leL.position.set(-3.28, 0.19, 0.10);
    g.add(leR); g.add(leL);

    /* 平尾 */
    var stabGeo = makeWing(0.9, 2.9, 8.4, 10.9, 10.2, 10.7, 0.18);
    var stabR = new THREE.Mesh(stabGeo, bodyMat2);
    stabR.position.y = 0.15;
    var stabL = new THREE.Mesh(stabGeo, bodyMat2);
    stabL.scale.x = -1; stabL.position.y = 0.15;
    var smL = bodyMat2.clone(); smL.side = THREE.DoubleSide; stabL.material = smL;
    var smR = bodyMat2.clone(); smR.side = THREE.DoubleSide; stabR.material = smR;
    g.add(stabR); g.add(stabL);

    /* 双垂尾 */
    function makeFin() {
      var s = new THREE.Shape();
      s.moveTo(0.0, 0.0);
      s.lineTo(2.4, 0.0);
      s.lineTo(1.5, 2.35);
      s.lineTo(0.5, 2.30);
      s.closePath();
      var geo = new THREE.ExtrudeGeometry(s, {
        depth: 0.16, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.03, bevelSegments: 1, curveSegments: 1
      });
      geo.rotateY(-Math.PI / 2);   // u -> +z, 厚度 -> -x
      geo.translate(0.08, 0, 0);
      return geo;
    }
    var finGeo = makeFin();
    var finMat = bodyMat2.clone(); finMat.side = THREE.DoubleSide;
    var finR = new THREE.Mesh(finGeo, finMat);
    finR.position.set(0.62, 0.72, 4.6);
    finR.rotation.z = -0.26;
    var finL = new THREE.Mesh(finGeo, finMat);
    finL.position.set(-0.62, 0.72, 4.6);
    finL.rotation.z = 0.26;
    finL.scale.x = -1;
    g.add(finR); g.add(finL);

    /* 座舱盖 */
    var canopyGeo = new THREE.SphereGeometry(0.62, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
    canopyGeo.scale(0.95, 0.95, 2.9);
    var canopy = new THREE.Mesh(canopyGeo, glassMat);
    canopy.position.set(0, 0.42, -3.5);
    g.add(canopy);
    var frame = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.045, 6, 16, Math.PI), darkMat);
    frame.position.set(0, 0.44, -3.5);
    frame.rotation.y = Math.PI / 2;
    frame.scale.set(1, 1.6, 1);
    g.add(frame);

    /* 进气道 */
    var intakeGeo = new THREE.BoxGeometry(0.44, 0.52, 2.6);
    var iR = new THREE.Mesh(intakeGeo, darkMat);
    iR.position.set(0.8, -0.22, -0.6);
    var iL = iR.clone(); iL.position.x = -0.8;
    g.add(iR); g.add(iL);

    /* 喷口 + 加力焰 */
    var nozGeo = new THREE.CylinderGeometry(0.40, 0.46, 1.5, 14, 1, true);
    nozGeo.rotateX(Math.PI / 2);
    var nozMat = new THREE.MeshStandardMaterial({ color: 0x4b4f54, metalness: 0.95, roughness: 0.30, side: THREE.DoubleSide, envMapIntensity: 1.2 });
    var nozR = new THREE.Mesh(nozGeo, nozMat);
    nozR.position.set(0.34, -0.05, 6.3);
    var nozL = nozR.clone(); nozL.position.x = -0.34;
    g.add(nozR); g.add(nozL);

    var glowMat = new THREE.MeshBasicMaterial({ color: 0xff7b2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    var flameGeo = new THREE.ConeGeometry(0.34, 1.0, 12, 1, true);
    flameGeo.rotateX(Math.PI / 2);    // 尖端朝 +Z（向后）
    flameGeo.translate(0, 0, 0.5);
    var flames = [];
    [0.34, -0.34].forEach(function (x) {
      var f = new THREE.Mesh(flameGeo, glowMat.clone());
      f.position.set(x, -0.05, 7.0);
      f.scale.set(1, 1, 1);
      g.add(f); flames.push(f);
    });

    /* 航行灯 */
    var navRed = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    var navGreen = new THREE.MeshBasicMaterial({ color: 0x22ff66 });
    var navGeo = new THREE.SphereGeometry(0.11, 8, 6);
    var l1 = new THREE.Mesh(navGeo, navRed); l1.position.set(-5.5, 0.14, 2.0);
    var l2 = new THREE.Mesh(navGeo, navGreen); l2.position.set(5.5, 0.14, 2.0);
    g.add(l1); g.add(l2);
    var strobe = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    strobe.position.set(0, 0.95, 4.3);
    g.add(strobe);

    g.userData.flames = flames;
    g.userData.strobe = strobe;
    g.userData.navL = l1; g.userData.navR = l2;
    return g;
  }

  var jet = buildJet();
  scene.add(jet);

  /* ---------------------------------------------------------------------
     6. 靶环 / 航线
     --------------------------------------------------------------------- */
  var ringGeo = new THREE.TorusGeometry(WORLD.ringRadius, 2.6, 8, 56);
  var ringMatBase = new THREE.MeshStandardMaterial({
    color: 0x2b2b2b, metalness: 0.75, roughness: 0.32,
    emissive: 0xff8c22, emissiveIntensity: 1.4, envMapIntensity: 1.0
  });
  var ringGroup = new THREE.Group();
  scene.add(ringGroup);
  var rings = [];

  function headingDir(h) { return new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)); }

  /* 保证靶环不会埋在山体 / 岩柱里 */
  function safeAlt(x, z, y) {
    var g = C.groundHeight(x, z);
    y = Math.max(y, g + 120);
    for (var i = 0; i < spires.length; i++) {
      var s = spires[i];
      if (Math.abs(x - s.x) < s.r + 110 && Math.abs(z - s.z) < s.r + 110) {
        y = Math.max(y, s.top + 80);
      }
    }
    return Math.min(y, 1600);
  }

  function nextRingSpec(from, heading) {
    var bestSpec = null;
    for (var attempt = 0; attempt < 9; attempt++) {
      var tight = 0.75 - attempt * 0.06;                 // 大转弯尝试失败后逐次收敛
      var h = heading + (Math.random() - 0.5) * tight;
      var dist = 980 + Math.random() * 720;
      var y = clamp(from.y + (Math.random() - 0.5) * 280, 130, 1150);
      var p = new THREE.Vector3(
        from.x + Math.sin(h) * dist,
        y,
        from.z - Math.cos(h) * dist
      );
      // 别飞太远：超出范围就折回中心
      if (Math.hypot(p.x, p.z) > 8200) {
        h = Math.atan2(-p.x, p.z) + (Math.random() - 0.5) * 0.7;
        p.set(from.x + Math.sin(h) * dist, y, from.z - Math.cos(h) * dist);
      }
      var sy = safeAlt(p.x, p.z, p.y);
      var spec = { pos: p.set(p.x, sy, p.z), heading: h };
      if (!bestSpec || (sy - from.y) < (bestSpec.pos.y - from.y)) bestSpec = spec;
      if (sy - from.y <= 300) return spec;               // 爬升/下降幅度可接受
    }
    return bestSpec;
  }

  function buildRings() {
    while (ringGroup.children.length) {
      var old = ringGroup.children[0];
      ringGroup.remove(old);
      if (old.material && old.material !== ringMatBase) old.material.dispose();
    }
    rings.length = 0;
    var prev = { pos: WORLD.spawn.clone().add(new THREE.Vector3(0, -20, -700)), heading: 0 };
    for (var i = 0; i < WORLD.ringCount; i++) {
      var spec = nextRingSpec(prev.pos, prev.heading);
      var mesh = new THREE.Mesh(ringGeo, ringMatBase.clone());
      mesh.position.copy(spec.pos);
      mesh.lookAt(spec.pos.clone().add(headingDir(spec.heading)));
      mesh.userData.phase = Math.random() * Math.PI * 2;
      ringGroup.add(mesh);
      rings.push({ mesh: mesh, pos: spec.pos, heading: spec.heading, pulse: 0 });
      prev = spec;
    }
  }

  function recycleRing() {
    var first = rings.shift();
    var last = rings[rings.length - 1];
    var spec = nextRingSpec(last.pos, last.heading);
    first.pos.copy(spec.pos);
    first.heading = spec.heading;
    first.pulse = 1;
    first.mesh.position.copy(spec.pos);
    first.mesh.lookAt(spec.pos.clone().add(headingDir(spec.heading)));
    rings.push(first);
    return first;
  }

  /* ---------------------------------------------------------------------
     7. 粒子（引擎尾迹 / 爆炸）
     --------------------------------------------------------------------- */
  function radialTexture(inner, outer) {
    var s = 128, cnv = document.createElement('canvas');
    cnv.width = cnv.height = s;
    var ctx = cnv.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, outer);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.fill();
    var t = new THREE.CanvasTexture(cnv);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  var smokeTex = radialTexture('rgba(255,255,255,0.85)', 'rgba(255,255,255,0.25)');
  var fireTex = radialTexture('rgba(255,245,200,1)', 'rgba(255,120,20,0.45)');

  var fxSprites = [];
  function spawnBurst(pos, count, tex, size, color, life, speed) {
    for (var i = 0; i < count; i++) {
      var m = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        opacity: 1, color: color
      });
      var sp = new THREE.Sprite(m);
      sp.position.copy(pos);
      var v = new THREE.Vector3(
        (Math.random() - 0.5) * speed, (Math.random() - 0.35) * speed, (Math.random() - 0.5) * speed
      );
      var sc = size * (0.6 + Math.random() * 0.8);
      sp.scale.set(sc, sc, 1);
      scene.add(sp);
      fxSprites.push({ sp: sp, v: v, life: life * (0.7 + Math.random() * 0.6), age: 0, size: sc });
    }
  }
  function updateFx(dt) {
    for (var i = fxSprites.length - 1; i >= 0; i--) {
      var p = fxSprites[i];
      p.age += dt;
      if (p.age >= p.life) {
        scene.remove(p.sp);
        p.sp.material.dispose();
        fxSprites.splice(i, 1);
        continue;
      }
      var k = p.age / p.life;
      p.sp.position.addScaledVector(p.v, dt);
      p.v.multiplyScalar(1 - dt * 1.4);
      p.v.y += dt * 6;
      var s = p.size * (1 + k * 2.6);
      p.sp.scale.set(s, s, 1);
      p.sp.material.opacity = (1 - k) * 0.95;
    }
  }

  /* ---------------------------------------------------------------------
     8. 游戏状态
     --------------------------------------------------------------------- */
  var G = {
    mode: 'menu',              // menu | playing | paused | crashing | over
    score: 0,
    ringCount: 0,
    distance: 0,
    best: 0,
    flight: C.createState(),
    camPos: new THREE.Vector3(0, 340, 560),
    camLook: new THREE.Vector3(0, 330, 0),
    time: 0,
    crashTimer: 0,
    shake: 0,
    mouseMode: false,
    mouse: { x: 0, y: 0 },
    throttleTarget: 0.55,
    targetRing: null,
    warnTimer: 0
  };
  try { G.best = parseInt(localStorage.getItem('skybreaker_best') || '0', 10) || 0; } catch (e) { G.best = 0; }

  /* ---------- 输入 ---------- */
  var keys = Object.create(null);
  var input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.55, boost: false };

  var KEYMAP = {
    ArrowUp: 'pitchUp', KeyI: 'pitchUp',
    ArrowDown: 'pitchDown', KeyK: 'pitchDown',
    ArrowLeft: 'rollLeft', KeyA: 'rollLeft',
    ArrowRight: 'rollRight', KeyD: 'rollRight',
    KeyQ: 'yawLeft', KeyE: 'yawRight',
    KeyW: 'thrUp', KeyS: 'thrDown',
    ShiftLeft: 'boost', ShiftRight: 'boost'
  };

  window.addEventListener('keydown', function (e) {
    if (e.repeat) { if (KEYMAP[e.code]) e.preventDefault(); return; }
    var a = KEYMAP[e.code];
    if (a) { keys[a] = true; e.preventDefault(); }

    if (e.code === 'Space' || e.code === 'Enter') {
      if (G.mode === 'menu') startGame();
      else if (G.mode === 'over') startGame();
      else if (G.mode === 'paused') resume();
      e.preventDefault();
    }
    if (e.code === 'KeyR' && (G.mode === 'over' || G.mode === 'playing' || G.mode === 'paused')) { startGame(); }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (G.mode === 'playing') pause();
      else if (G.mode === 'paused') resume();
    }
    if (e.code === 'KeyM') toggleMouse();
  });
  window.addEventListener('keyup', function (e) {
    var a = KEYMAP[e.code];
    if (a) { keys[a] = false; e.preventDefault(); }
  });
  window.addEventListener('blur', function () { for (var k in keys) keys[k] = false; });

  /* 鼠标 / 触摸 */
  canvas.addEventListener('mousemove', function (e) {
    if (!G.mouseMode) return;
    G.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    G.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
  });
  window.addEventListener('wheel', function (e) {
    if (G.mode !== 'playing') return;
    if (G.mouseMode) {
      G.throttleTarget = clamp(G.throttleTarget - e.deltaY * 0.0006, 0, 1);
      e.preventDefault();
    }
  }, { passive: false });

  function toggleMouse() {
    G.mouseMode = !G.mouseMode;
    ui.mouseTag.textContent = G.mouseMode ? '鼠标操控：开' : '鼠标操控：关';
    ui.mouseTag.classList.toggle('on', G.mouseMode);
    if (ui.btnMouse) {
      ui.btnMouse.textContent = G.mouseMode ? '鼠标操控：开' : '鼠标操控：关';
      ui.btnMouse.classList.toggle('on', G.mouseMode);
    }
    G.mouse.x = 0; G.mouse.y = 0;
    toast(G.mouseMode ? '鼠标操控已开启 · 滚轮调节油门' : '鼠标操控已关闭 · 使用键盘');
  }

  function readInput(dt) {
    var pitch = 0, roll = 0, yaw = 0;
    if (keys.pitchUp) pitch += 1;
    if (keys.pitchDown) pitch -= 1;
    if (keys.rollLeft) roll -= 1;
    if (keys.rollRight) roll += 1;
    if (keys.yawLeft) yaw -= 1;
    if (keys.yawRight) yaw += 1;

    if (G.mouseMode) {
      var dz = 0.06;
      var mx = G.mouse.x, my = G.mouse.y;
      if (Math.abs(mx) > dz) roll += clamp((mx - Math.sign(mx) * dz) / 0.55, -1, 1);
      if (Math.abs(my) > dz) pitch += clamp((-(my - Math.sign(my) * dz)) / 0.55, -1, 1);
      pitch = clamp(pitch, -1, 1);
      roll = clamp(roll, -1, 1);
    }

    if (keys.thrUp) G.throttleTarget = clamp(G.throttleTarget + dt * 0.55, 0, 1);
    if (keys.thrDown) G.throttleTarget = clamp(G.throttleTarget - dt * 0.55, 0, 1);

    input.pitch = pitch;
    input.roll = roll;
    input.yaw = yaw;
    input.throttle = G.throttleTarget;
    input.boost = !!keys.boost;
    return input;
  }

  /* ---------- UI 辅助 ---------- */
  var toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, 1800);
  }

  function show(el) { el.classList.add('show'); }
  function hide(el) { el.classList.remove('show'); }

  /* ---------- 开始 / 重开 / 暂停 ---------- */
  function resetWorld() {
    var st = C.createState();
    st.pos.copy(WORLD.spawn);
    st.quat.identity();
    st.vel.set(0, 0, -125);
    st.throttle = 0.62;
    G.flight = st;
    G.score = 0; G.ringCount = 0; G.distance = 0; G.time = 0;
    G.throttleTarget = 0.62;
    G.crashTimer = 0; G.shake = 0;
    G.mouse.x = 0; G.mouse.y = 0;

    buildRings();
    // 清特效
    for (var i = fxSprites.length - 1; i >= 0; i--) {
      scene.remove(fxSprites[i].sp); fxSprites[i].sp.material.dispose();
    }
    fxSprites.length = 0;

    jet.visible = true;
    jet.position.copy(st.pos);
    jet.quaternion.copy(st.quat);

    var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(st.quat);
    G.camPos.copy(st.pos).addScaledVector(fwd, -28).add(new THREE.Vector3(0, 7, 0));
    G.camLook.copy(st.pos);
    camera.position.copy(G.camPos);
    camera.lookAt(G.camLook);
  }

  function startGame() {
    resetWorld();
    G.mode = 'playing';
    hide(ui.start); hide(ui.over); hide(ui.pause);
    ui.hud.classList.add('show');
    ui.flash.style.opacity = '0';
    toast('目标：穿过所有橙色靶环');
  }

  function pause() {
    if (G.mode !== 'playing') return;
    G.mode = 'paused';
    show(ui.pause);
  }
  function resume() {
    if (G.mode !== 'paused') return;
    G.mode = 'playing';
    hide(ui.pause);
    last = performance.now();
  }

  function gameOver(reason) {
    G.mode = 'over';
    if (G.score > G.best) {
      G.best = G.score;
      try { localStorage.setItem('skybreaker_best', String(G.best)); } catch (e) { }
    }
    ui.finalScore.textContent = Math.round(G.score).toLocaleString('zh-CN');
    ui.finalRings.textContent = G.ringCount;
    ui.finalDist.textContent = (G.distance / 1000).toFixed(2) + ' km';
    ui.best.textContent = Math.round(G.best).toLocaleString('zh-CN');
    var dup = document.getElementById('bestScoreDup');
    if (dup) dup.textContent = Math.round(G.best).toLocaleString('zh-CN');
    document.getElementById('overReason').textContent = reason;
    show(ui.over);
    ui.hud.classList.remove('show');
  }

  function crash(reason) {
    if (G.mode !== 'playing') return;
    G.mode = 'crashing';
    G.crashTimer = 0;
    var p = G.flight.pos.clone();
    spawnBurst(p, 26, fireTex, 26, 0xff9a3c, 1.5, 55);
    spawnBurst(p, 18, smokeTex, 40, 0x555555, 2.6, 26);
    jet.visible = false;
    setTimeout(function () {
      if (G.mode === 'crashing') gameOver(reason || '飞机损毁');
    }, 1400);
  }

  /* ---------------------------------------------------------------------
     9. 每帧逻辑
     --------------------------------------------------------------------- */
  var tmpV = new THREE.Vector3();
  var tmpV2 = new THREE.Vector3();
  var tmpQ = new THREE.Quaternion();
  var tmpRollQ = new THREE.Quaternion();
  var tmpE = new THREE.Euler();

  function updateFlight(dt) {
    var st = G.flight;
    var ctrl = readInput(dt);

    // 子步进，避免高速穿透
    var steps = Math.min(3, Math.max(1, Math.ceil(dt / 0.017)));
    var sub = dt / steps;
    var prevPos = tmpV.copy(st.pos);
    for (var i = 0; i < steps; i++) {
      C.stepFlight(st, ctrl, sub);
      checkCollisions(st);
      if (G.mode !== 'playing') return;
    }

    G.distance += st.pos.distanceTo(prevPos);

    jet.position.copy(st.pos);
    jet.quaternion.copy(st.quat);

    // 引擎火焰
    var thr = st.throttle;
    var flick = 0.85 + Math.random() * 0.3;
    jet.userData.flames.forEach(function (f) {
      f.visible = thr > 0.06;
      f.scale.set(0.55 + thr * 0.7, 0.55 + thr * 0.7, (0.4 + thr * 3.4 + (st.abOn ? 2.4 : 0)) * flick);
      f.material.opacity = clamp(0.25 + thr * 0.85, 0, 1);
      f.material.color.setHex(st.abOn ? 0x9fc4ff : 0xff7b2a);
    });
    // 航行灯闪烁
    var blink = (Math.sin(performance.now() * 0.004) > 0.86) ? 1 : 0.12;
    jet.userData.strobe.material.opacity = blink;
    jet.userData.strobe.visible = blink > 0.5;
  }

  function checkCollisions(st) {
    // 地面 / 海面
    var gh = C.groundHeight(st.pos.x, st.pos.z);
    if (st.pos.y <= gh + 4.5) {
      crash(gh < 1 ? '坠入海中' : '撞上山体');
      return;
    }
    // 岩柱
    for (var i = 0; i < spires.length; i++) {
      var s = spires[i];
      if (st.pos.y > s.top) continue;
      var dx = st.pos.x - s.x, dz = st.pos.z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) {
        crash('撞上岩柱');
        return;
      }
    }
    // 靶环
    var target = rings[0];
    if (!target) return;
    var d = st.pos.distanceTo(target.pos);
    if (d < WORLD.ringRadius * 1.02) {
      G.score += 100 + Math.round(st.speed * 0.55);
      G.ringCount++;
      spawnBurst(target.pos, 10, fireTex, 14, 0xffb35c, 0.9, 30);
      recycleRing();
      G.shake = Math.max(G.shake, 0.25);
      if (G.ringCount % 5 === 0) toast('连穿 ' + G.ringCount + ' 环！' + (G.ringCount >= 15 ? ' 王牌飞行员' : ''));
    } else if (d > 4200) {
      // 跑太远：把靶环搬到航向前方
      var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(st.quat);
      var h = Math.atan2(fwd.x, -fwd.z);
      var spec = nextRingSpec(st.pos, h);
      target.pos.copy(spec.pos);
      target.heading = spec.heading;
      target.mesh.position.copy(spec.pos);
      target.mesh.lookAt(spec.pos.clone().add(headingDir(spec.heading)));
      toast('已重新定位靶环');
    }
  }

  function updateRings(dt) {
    var t = performance.now() * 0.001;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      var isTarget = (i === 0);
      var m = r.mesh;
      if (r.pulse > 0) r.pulse = Math.max(0, r.pulse - dt * 2.2);
      var base = isTarget ? 1.6 + Math.sin(t * 2.4) * 0.75 : 0.55;
      m.material.emissiveIntensity = base + r.pulse * 3.0;
      m.material.emissive.setHex(isTarget ? 0xff8c22 : 0x2f7fb5);
      var sc = 1 + r.pulse * 0.14 + (isTarget ? Math.sin(t * 2.4) * 0.012 : 0);
      m.scale.setScalar(sc);
    }
  }

  function updateCamera(dt) {
    var st = G.flight;
    var fwd = tmpV.set(0, 0, -1).applyQuaternion(st.quat);
    var up = tmpV2.set(0, 1, 0).applyQuaternion(st.quat);

    tmpE.setFromQuaternion(st.quat, 'YXZ');
    // 相机跟随（滚转打折，视觉更稳、更有电影感）
    tmpQ.setFromEuler(new THREE.Euler(tmpE.x * 0.62, tmpE.y, tmpE.z * 0.55, 'YXZ'));

    var offset = new THREE.Vector3(0, 5.2, 32.0);
    var desired = offset.applyQuaternion(tmpQ).add(st.pos);
    // 别让相机钻到地下
    var groundAtCam = C.groundHeight(desired.x, desired.z) + 6;
    if (desired.y < groundAtCam) desired.y = groundAtCam;

    var k = 1 - Math.exp(-dt * 6.5);
    G.camPos.lerp(desired, k);

    var lookTarget = st.pos.clone().addScaledVector(fwd, 34).addScaledVector(up, 2.2);
    G.camLook.lerp(lookTarget, 1 - Math.exp(-dt * 9));

    camera.position.copy(G.camPos);

    // 镜头抖动
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 1.6);
    var spd = clamp((st.speed - 80) / 180, 0, 1);
    var shakeAmt = G.shake * 0.9 + spd * 0.10 + st.stall * 0.35;
    if (shakeAmt > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shakeAmt * 2.2;
      camera.position.y += (Math.random() - 0.5) * shakeAmt * 2.2;
      camera.position.z += (Math.random() - 0.5) * shakeAmt * 2.2;
    }

    // 相机随飞机滚转 42%（用绕视轴旋转，避免万向锁/退化）
    tmpRollQ.setFromAxisAngle(fwd, -st.bank * 0.42);
    camera.up.set(0, 1, 0).applyQuaternion(tmpRollQ).normalize();
    camera.lookAt(G.camLook);

    // 速度感：FOV 拉伸
    var fovTarget = lerp(60, 76, clamp((st.speed - 70) / 190, 0, 1)) + (st.abOn ? 3 : 0);
    camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-dt * 3));
    camera.updateProjectionMatrix();

    skyDome.position.copy(camera.position);
  }

  function projectToScreen(v3) {
    var p = v3.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, z: p.z };
  }

  var hudAccum = 0;
  function updateHUD(dt) {
    var st = G.flight;
    hudAccum += dt;

    // 速度矢量标记（真实 HUD 的飞行路径矢量）
    var velDir = tmpV.copy(st.vel);
    if (velDir.lengthSq() > 1) {
      velDir.normalize().multiplyScalar(900).add(st.pos);
      var s = projectToScreen(velDir);
      if (s.z < 1 && s.x > 0 && s.x < window.innerWidth && s.y > 0 && s.y < window.innerHeight) {
        ui.marker.style.transform = 'translate(' + s.x + 'px,' + s.y + 'px)';
        ui.marker.style.opacity = '0.95';
      } else ui.marker.style.opacity = '0';
    }

    // 目标指示箭头
    var tgt = rings[0];
    if (tgt) {
      var sp = projectToScreen(tgt.pos);
      var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      var onScreen = (sp.z < 1 && sp.x > 40 && sp.x < window.innerWidth - 40 && sp.y > 90 && sp.y < window.innerHeight - 120);
      var dx = sp.x - cx, dy = sp.y - cy;
      if (sp.z >= 1) { dx = -dx; dy = -dy; }
      var len = Math.hypot(dx, dy) || 1;
      if (onScreen) {
        ui.arrow.style.opacity = '0';
      } else {
        var R = Math.min(cx, cy) * 0.62;
        var ax = cx + (dx / len) * R;
        var ay = cy + (dy / len) * R;
        var ang = Math.atan2(dy, dx) * 180 / Math.PI;
        ui.arrow.style.opacity = '0.95';
        ui.arrow.style.transform = 'translate(' + ax + 'px,' + ay + 'px) rotate(' + ang + 'deg)';
      }
      var dd = st.pos.distanceTo(tgt.pos);
      ui.tgtDist.textContent = (dd / 1000).toFixed(2) + ' km';
    }

    // 姿态仪
    var e = tmpE.setFromQuaternion(st.quat, 'YXZ');
    var pitchDeg = clamp(e.x * 180 / Math.PI, -90, 90);
    var rollDeg = clamp(e.z * 180 / Math.PI, -180, 180);
    ui.attInner.style.transform = 'rotate(' + rollDeg + 'deg) translateY(' + (pitchDeg * 1.1) + 'px)';

    // 数字仪表 @ 12Hz
    if (hudAccum < 0.08) return;
    hudAccum = 0;

    ui.score.textContent = Math.round(G.score).toLocaleString('zh-CN');
    ui.rings.textContent = G.ringCount;
    ui.dist.textContent = (G.distance / 1000).toFixed(2);
    ui.spd.textContent = Math.round(st.speed * 3.6);
    ui.alt.textContent = Math.round(st.pos.y);
    var vs = st.vel.y;
    ui.vs.textContent = (vs >= 0 ? '+' : '') + vs.toFixed(1);
    ui.vs.classList.toggle('up', vs >= 0);
    ui.vs.classList.toggle('down', vs < 0);
    ui.thr.textContent = Math.round(st.throttle * 100);
    ui.thrBar.style.width = (st.throttle * 100).toFixed(0) + '%';
    ui.thrBar.classList.toggle('ab', !!st.abOn);
    ui.g.textContent = st.gForce.toFixed(1);

    // 近地告警
    var gh = C.groundHeight(st.pos.x, st.pos.z);
    var agl = st.pos.y - gh;
    if (agl < 90 && st.vel.y < 2) {
      ui.warn.textContent = '⚠ 拉起 PULL UP';
      ui.warn.classList.add('show');
    } else if (st.stall > 0.15) {
      ui.warn.textContent = '⚠ 失速 STALL';
      ui.warn.classList.add('show');
    } else {
      ui.warn.classList.remove('show');
    }
  }

  /* ---------------------------------------------------------------------
     10. 主循环
     --------------------------------------------------------------------- */
  var last = performance.now();
  var acc = 0, frames = 0, fpsTimer = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0.016;
    dt = Math.min(dt, 0.05);

    if (G.mode === 'playing') {
      G.time += dt;
      updateFlight(dt);
      if (G.mode === 'playing') updateRings(dt);
    } else if (G.mode === 'crashing') {
      G.crashTimer += dt;
      var st = G.flight;
      st.pos.y = Math.min(st.pos.y, C.groundHeight(st.pos.x, st.pos.z) + 2);
      // 爆炸后镜头缓慢上抬
      G.camLook.lerp(G.flight.pos, 1 - Math.exp(-dt * 2));
    } else if (G.mode === 'menu') {
      // 菜单：飞机特写缓慢环绕
      var t = now * 0.00022;
      var ang = Math.PI * 0.30 + Math.sin(t) * 0.55;
      var R = 33;
      var sp = WORLD.spawn;
      camera.position.set(sp.x + Math.sin(ang) * R + 6, sp.y + 7 + Math.sin(t * 1.7) * 3.2, sp.z - Math.cos(ang) * R);
      camera.up.set(0, 1, 0);
      camera.lookAt(sp.x, sp.y - 2, sp.z);
      if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
      jet.position.copy(WORLD.spawn);
      jet.rotation.set(0, Math.sin(t * 2) * 0.05, Math.sin(t * 1.3) * 0.04);
    }

    if (G.mode === 'playing' || G.mode === 'crashing' || G.mode === 'paused') {
      if (G.mode !== 'paused') updateCamera(dt);
    }

    skyDome.position.copy(camera.position);
    updateFx(dt);
    if (G.mode === 'playing' || G.mode === 'crashing') updateHUD(dt);

    renderer.render(scene, camera);

    // 简易自适应分辨率
    frames++; fpsTimer += dt;
    if (fpsTimer > 1.5) {
      var fps = frames / fpsTimer;
      if (fps < 42 && renderer.getPixelRatio() > 1.0) {
        renderer.setPixelRatio(Math.max(1.0, renderer.getPixelRatio() - 0.25));
      }
      frames = 0; fpsTimer = 0;
    }
  }

  /* ---------------------------------------------------------------------
     11. 事件绑定 / 启动
     --------------------------------------------------------------------- */
  ui.btnStart.addEventListener('click', startGame);
  ui.btnAgain.addEventListener('click', startGame);
  ui.btnResume.addEventListener('click', resume);

  document.getElementById('btnMouse').addEventListener('click', toggleMouse);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && G.mode === 'playing') pause();
  });

  // 初始化一个静置状态用于菜单镜头
  resetWorld();
  G.mode = 'menu';
  ui.best.textContent = Math.round(G.best).toLocaleString('zh-CN');
  ui.loading.classList.add('gone');
  show(ui.start);
  requestAnimationFrame(loop);

  // 供调试
  global.__JET__ = { G: G, rings: rings, spires: spires, camera: camera, scene: scene, startGame: startGame };

})(typeof window !== 'undefined' ? window : globalThis);
