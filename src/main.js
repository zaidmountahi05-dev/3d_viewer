import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d'

const root = document.getElementById('viewer')
const statusEl = document.getElementById('status')
const titleEl = document.getElementById('title')
const subtitleEl = document.getElementById('subtitle')
const toolbarEl = document.getElementById('toolbar')
const topbarEl = document.getElementById('topbar')
const toggleUiBtn = document.getElementById('toggle-ui-btn')
const autoRotateBtn = document.getElementById('autorotate-btn')
const orbitBtn = document.getElementById('orbit-btn')
const distanceSlider = document.getElementById('distance-slider')

const params = new URLSearchParams(window.location.search)

const modelUrl = params.get('modelUrl') || ''
const format = (params.get('format') || detectFormatFromUrl(modelUrl)).toLowerCase()
const sceneId = params.get('sceneId') || 'unknown-scene'
const title = params.get('title') || '3D Model Viewer'
const subtitle = params.get('subtitle') || sceneId
const target = parseVector(params.get('target'), [0, 1.2, 0])
const distance = parseNumber(params.get('distance'), 3.5)
const rotationDeg = parseVector(params.get('rotationDeg'), [0, 0, 0])
const minDistance = parseNumber(
  params.get('minDistance'),
  Math.max(0.5, distance * 0.3)
)
const maxDistance = parseNumber(
  params.get('maxDistance'),
  Math.max(20, distance * 10)
)
const orbitSpeed = parseNumber(params.get('orbitSpeed'), 1.0)

function detectFormatFromUrl(url) {
  const value = String(url || '').toLowerCase()

  if (value.includes('.ksplat')) return 'ksplat'
  if (value.includes('.splat')) return 'splat'
  if (value.includes('.ply')) return 'ply'

  return 'splat'
}

function toSceneFormat(nextFormat) {
  if (nextFormat === 'ply') return GaussianSplats3D.SceneFormat.Ply
  if (nextFormat === 'ksplat') return GaussianSplats3D.SceneFormat.KSplat
  return GaussianSplats3D.SceneFormat.Splat
}

function eulerDegreesToQuaternion(deg) {
  const [x, y, z] = deg.map((v) => THREE.MathUtils.degToRad(Number(v || 0)))
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(x, y, z, 'XYZ')
  )
  return [q.x, q.y, q.z, q.w]
}

titleEl.textContent = title
subtitleEl.textContent = subtitle

let viewer = null
let renderer = null
let camera = null
let controls = null
let animationHandle = 0

const state = {
  target: new THREE.Vector3(...target),
  baseDistance: distance,
  autoRotate: false,
  scriptedOrbit: false,
  orbitAngle: 0,
  orbitSpeed,
  disposed: false
}

init().catch((error) => {
  console.error(error)
  setStatus(`Failed to initialize: ${error.message || error}`)
  postMiniProgramMessage({
    type: 'viewer-error',
    message: error.message || String(error)
  })
})

async function init() {
  if (!modelUrl) {
    throw new Error('Missing modelUrl in query string')
  }

  setStatus('Creating WebGL renderer...')

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance'
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(root.clientWidth, root.clientHeight)
  root.appendChild(renderer.domElement)

  camera = new THREE.PerspectiveCamera(
    65,
    root.clientWidth / root.clientHeight,
    0.1,
    1000
  )

  camera.position.set(
    state.target.x,
    state.target.y,
    state.target.z + state.baseDistance
  )
  camera.lookAt(state.target)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(state.target)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = true
  controls.enableZoom = true
  controls.enableRotate = true
  controls.screenSpacePanning = true
  controls.rotateSpeed = 0.9
  controls.panSpeed = 0.8
  controls.zoomSpeed = 1.0
  controls.minDistance = minDistance
  controls.maxDistance = maxDistance
  controls.autoRotate = false
  controls.autoRotateSpeed = 2.0 * state.orbitSpeed
  controls.update()

  if (distanceSlider) {
    distanceSlider.min = String(minDistance)
    distanceSlider.max = String(maxDistance)
    distanceSlider.step = '0.1'
    distanceSlider.value = String(state.baseDistance)
  }

  setStatus(`Loading gaussian scene (${format})...`)

  viewer = new GaussianSplats3D.Viewer({
    selfDrivenMode: false,
    renderer,
    camera,
    useBuiltInControls: false,
    ignoreDevicePixelRatio: false,
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
    integerBasedSort: false,
    halfPrecisionCovariancesOnGPU: true,
    dynamicScene: false,
    renderMode: GaussianSplats3D.RenderMode.Always,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    antialiased: false,
    focalAdjustment: 1.0,
    logLevel: GaussianSplats3D.LogLevel.None,
    sphericalHarmonicsDegree: 0,
    enableOptionalEffects: false
  })

  console.log('init params', {
    modelUrl,
    format,
    sceneId,
    target,
    distance,
    rotationDeg,
    minDistance,
    maxDistance,
    orbitSpeed
  })

  await viewer.addSplatScene(modelUrl, {
    format: toSceneFormat(format),
    rotation: eulerDegreesToQuaternion(rotationDeg),
    showLoadingUI: true,
    splatAlphaRemovalThreshold: 5,
    progressiveLoad: true
  })

  console.log('addSplatScene finished')

  bindUI()
  bindResize()
  animate()

  setStatus('Ready. Drag to orbit, pinch to zoom, two-finger drag to pan.')
  postMiniProgramMessage({
    type: 'viewer-ready',
    sceneId,
    modelUrl
  })
}

function animate() {
  if (state.disposed) return

  animationHandle = requestAnimationFrame(animate)

  if (state.scriptedOrbit) {
    controls.autoRotate = false
    updateScriptedOrbit()
    controls.update()
  } else {
    controls.autoRotate = state.autoRotate
    controls.update()
  }

  if (viewer) {
    viewer.update()
    viewer.render()
  }

  throttledCameraReport()
}

function updateScriptedOrbit() {
  if (!state.scriptedOrbit) return

  state.orbitAngle += 0.01 * state.orbitSpeed

  const r = state.baseDistance
  const x = state.target.x + Math.cos(state.orbitAngle) * r
  const z = state.target.z + Math.sin(state.orbitAngle) * r
  const y = camera.position.y

  camera.position.set(x, y, z)
  camera.lookAt(state.target)
  controls.target.copy(state.target)
}

function setOrbitDistance(nextDistance) {
  const clamped = THREE.MathUtils.clamp(
    nextDistance,
    controls.minDistance,
    controls.maxDistance
  )

  const direction = new THREE.Vector3()
    .subVectors(camera.position, controls.target)
    .normalize()

  camera.position.copy(
    controls.target.clone().add(direction.multiplyScalar(clamped))
  )

  state.baseDistance = clamped
  controls.update()

  if (distanceSlider) {
    distanceSlider.value = String(clamped)
  }

  setStatus(`Distance: ${round(clamped)}`)
}

function bindResize() {
  window.addEventListener('resize', () => {
    if (!camera || !renderer) return
    camera.aspect = root.clientWidth / root.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(root.clientWidth, root.clientHeight)
  })
}

function bindUI() {
  if (toolbarEl) {
    toolbarEl.addEventListener('click', (event) => {
      const button = event.target.closest('button')
      if (!button) return

      const preset = button.dataset.preset
      if (!preset) return

      applyPreset(preset)
    })
  }

  if (autoRotateBtn) {
    autoRotateBtn.addEventListener('click', () => {
      state.autoRotate = !state.autoRotate
      state.scriptedOrbit = false

      autoRotateBtn.textContent = `Auto Rotate: ${state.autoRotate ? 'On' : 'Off'}`

      if (orbitBtn) {
        orbitBtn.textContent = `Orbit Path: ${state.scriptedOrbit ? 'On' : 'Off'}`
      }
    })
  }

if (orbitBtn) {
  orbitBtn.addEventListener('click', () => {
    state.scriptedOrbit = !state.scriptedOrbit
    state.autoRotate = false
    controls.autoRotate = false
  
    orbitBtn.textContent = `Orbit Path: ${state.scriptedOrbit ? 'On' : 'Off'}`
  
    if (autoRotateBtn) {
      autoRotateBtn.textContent = `Auto Rotate: ${state.autoRotate ? 'On' : 'Off'}`
    }
  })
}

  if (distanceSlider) {
    distanceSlider.addEventListener('input', (event) => {
      setOrbitDistance(Number(event.target.value))
    })
  }

  if (toggleUiBtn) {
    toggleUiBtn.addEventListener('click', () => {
      const hidden = toolbarEl ? toolbarEl.classList.toggle('hidden') : false
      if (topbarEl) {
        topbarEl.classList.toggle('hidden', hidden)
      }
      toggleUiBtn.textContent = hidden ? 'Show UI' : 'Hide UI'
    })
  }
}

function applyPreset(name) {
  const next = getPresetPosition(name, state.target, state.baseDistance)
  if (!next) return

  state.scriptedOrbit = false
  state.autoRotate = false

  if (orbitBtn) {
    orbitBtn.textContent = 'Orbit Path: Off'
  }

  if (autoRotateBtn) {
    autoRotateBtn.textContent = 'Auto Rotate: Off'
  }

  camera.position.copy(next.position)
  controls.target.copy(next.target)
  controls.update()

  setStatus(`Switched to ${name} view`)
  postMiniProgramMessage({
    type: 'camera-preset',
    preset: name,
    camera: serializeCamera()
  })
}

function getPresetPosition(name, targetVec, baseDistance) {
  const d = baseDistance

  if (name === 'front') {
    return {
      position: new THREE.Vector3(targetVec.x, targetVec.y, targetVec.z + d),
      target: targetVec.clone()
    }
  }

  if (name === 'left') {
    return {
      position: new THREE.Vector3(targetVec.x - d, targetVec.y, targetVec.z),
      target: targetVec.clone()
    }
  }

  if (name === 'right') {
    return {
      position: new THREE.Vector3(targetVec.x + d, targetVec.y, targetVec.z),
      target: targetVec.clone()
    }
  }

  if (name === 'top') {
    return {
      position: new THREE.Vector3(
        targetVec.x,
        targetVec.y + d,
        targetVec.z + 0.001
      ),
      target: targetVec.clone()
    }
  }

  if (name === 'reset') {
    return {
      position: new THREE.Vector3(targetVec.x, targetVec.y, targetVec.z + d),
      target: targetVec.clone()
    }
  }

  return null
}

function serializeCamera() {
  return {
    position: {
      x: round(camera.position.x),
      y: round(camera.position.y),
      z: round(camera.position.z)
    },
    target: {
      x: round(controls.target.x),
      y: round(controls.target.y),
      z: round(controls.target.z)
    },
    distance: round(camera.position.distanceTo(controls.target))
  }
}

let lastCameraSentAt = 0
function throttledCameraReport() {
  const now = performance.now()
  if (now - lastCameraSentAt < 500) return
  lastCameraSentAt = now

  postMiniProgramMessage({
    type: 'camera-changed',
    camera: serializeCamera()
  })
}

function setStatus(message) {
  if (statusEl) {
    statusEl.textContent = message
  }
}

function parseVector(value, fallback) {
  if (!value) return fallback
  const parts = value.split(',').map((v) => Number(v.trim()))
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return fallback
  }
  return parts
}

function parseNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

function postMiniProgramMessage(payload) {
  try {
    if (window.wx && window.wx.miniProgram && window.wx.miniProgram.postMessage) {
      window.wx.miniProgram.postMessage({ data: payload })
      return
    }
  } catch (error) {
    console.warn('wx.miniProgram.postMessage failed:', error)
  }

  try {
    if (window.parent) {
      window.parent.postMessage(payload, '*')
    }
  } catch (error) {
    console.warn('window.parent.postMessage failed:', error)
  }
}

window.addEventListener('beforeunload', () => {
  state.disposed = true
  cancelAnimationFrame(animationHandle)

  if (controls) {
    controls.dispose()
  }

  if (viewer && typeof viewer.dispose === 'function') {
    viewer.dispose()
  }

  if (renderer) {
    renderer.dispose()
  }
})
