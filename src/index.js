/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// All (namespace) imports first
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
// Multiple imports next, sorted by imported identifier (ESLint sort-imports)
import { XR_AXES, XR_BUTTONS } from 'gamepad-wrapper';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gsap } from 'gsap';
import { init } from './init.js';

const bullets = {};
const forwardVector = new THREE.Vector3(0, 0, -1);
const bulletSpeed = 15; // Increased speed
const bulletTimeToLive = 3; // Increased TTL to 3 seconds

const blasterGroup = new THREE.Group();
const blueBlasterGroup = new THREE.Group(); // New blue weapon group

// Flamethrower particles
let flamethrowerParticles = [];
let maxFlamethrowerParticles = 100;
let flamethrowerParticlePool = [];

// Weapon switching
let currentWeapon = 0; // 0 = red weapon, 1 = blue weapon (flamethrower)
const weapons = [blasterGroup, blueBlasterGroup];

const RUN_SPEED = 2.5;
const WALK_SPEED = 0.8;
const ATTACK_THRESHOLD = 5; // Distance to stop and attack (or idle)
const WALK_THRESHOLD = 12; // Distance to switch from running to walking

const AVOIDANCE_RADIUS = 3.0; // For cowboy-cowboy avoidance
const OBSTACLE_AVOIDANCE_RADIUS = 8.0; // For cowboy-obstacle avoidance
const AVOIDANCE_STRENGTH = 3.0; // Increased strength

// Cowboy enemies
const cowboys = [];
const cowboyMixers = [];
let cowboyGltf = null;

// Road and movement
let road = null;
let backgroundPlane = null;
window.playerPosition = 0; // Make it globally accessible
let globalCamera = null; // Global reference to camera for cowboy targeting

// Mouse controls
let mouseBlaster = null;
let isMouseMode = false;
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const keyStates = {};
const obstacles = [];

let laserSound, scoreSound;



function spawnCowboy(scene) {
	if (!cowboyGltf || blasterGroup.children.length === 0) {
		// Also check if blaster is loaded
		console.log('No cowboy or blaster GLTF loaded yet');
		console.log('BlasterGroup children count:', blasterGroup.children.length);
		if (blasterGroup.children.length > 0) {
			console.log('First blaster child:', blasterGroup.children[0]);
		}
		return;
	}

	console.log('Spawning cowboy...');
	console.log('BlasterGroup children count:', blasterGroup.children.length);
	if (blasterGroup.children.length > 0) {
		console.log('First blaster child:', blasterGroup.children[0]);
	}

	// Properly clone the GLTF scene with animations using SkeletonUtils
	const cowboy = SkeletonUtils.clone(cowboyGltf.scene);

	// Set position on either side of the road, close to the player
	const side = Math.random() > 0.5 ? 1 : -1; // Left or right side
	const distanceFromRoad = 3 + Math.random() * 2; // 3-5 units from road center

	// Use window.playerPosition for positioning
	cowboy.position.set(
		side * distanceFromRoad,    // X: left or right of road
		0,                          // Y: ground level
		-window.playerPosition - 5 - Math.random() * 5  // Z: close to player (5-10 units ahead)
	);

	// Make the cowboy face the player's blaster position
	// Initially point toward a default position, will be updated in onFrame
	cowboy.lookAt(0, 1.6, -window.playerPosition); // Default to player's eye level

	cowboy.scale.setScalar(1.2);
	scene.add(cowboy);
	cowboys.push(cowboy);

	console.log('Cowboy added to scene at position:', cowboy.position);
	console.log('Total cowboys:', cowboys.length);

	// Store shooting interval for this cowboy
	const shootInterval = setInterval(() => {
		// Shoot at the player every 3 seconds
		if (globalCamera) {
			shootAtPlayer(cowboy, scene, globalCamera);
		}
	}, 3000);

	// Store the interval ID so we can clear it later
	cowboy.userData.shootInterval = shootInterval;

	console.log('Cowboy added to scene at position:', cowboy.position);
	console.log('Total cowboys:', cowboys.length);

	// Setup animation mixer for this cowboy
	if (cowboyGltf.animations && cowboyGltf.animations.length > 0) {
		const mixer = new THREE.AnimationMixer(cowboy);
		const cowboyData = {
			mixer: mixer,
			animations: cowboyGltf.animations,
			currentAction: null,
			idleAction: null,
			deathAction: null,
			walkAction: null,
			runAction: null
		};
		cowboyMixers.push(cowboyData);

		console.log('Setting up animations, found:', cowboyGltf.animations.length, 'animations');

		// Find and play wink animation (or first available animation)
		let idleAction = null;
		let deathAction = null;
		let walkAction = null;
		let runAction = null;

		for (let animation of cowboyGltf.animations) {
			const animName = animation.name.toLowerCase();
			if (animName.includes('wink') || animName.includes('wave') || animName.includes('greeting')) {
				idleAction = mixer.clipAction(animation);
			} else if (animName.includes('dead')) {
				deathAction = mixer.clipAction(animation);
			} else if (animName.includes('walk')) {
				walkAction = mixer.clipAction(animation);
			} else if (animName.includes('run')) {
				runAction = mixer.clipAction(animation);
			}
		}

		// If no specific animations found, use first animation as idle
		if (!idleAction && cowboyGltf.animations.length > 0) {
			idleAction = mixer.clipAction(cowboyGltf.animations[0]);
			console.log('Using first animation as idle:', cowboyGltf.animations[0].name);
		}

		// Store all animation references
		cowboyData.idleAction = idleAction;
		cowboyData.deathAction = deathAction;
		cowboyData.walkAction = walkAction;
		cowboyData.runAction = runAction;

		// Start with idle animation
		if (idleAction) {
			idleAction.setLoop(THREE.LoopRepeat, Infinity);
			idleAction.play();
			cowboyData.currentAction = idleAction;
			console.log('Idle animation started');
		}

		// Store animation references in userData
		cowboy.userData = {
			...cowboy.userData,
			idleAction: idleAction,
			deathAction: deathAction,
			walkAction: walkAction,
			runAction: runAction,
			hasPlayedDeath: false
		};

	} else {
		console.log('No animations found for cowboy');
	}
}

function shootAtPlayer(cowboy, scene, camera) {
	// Check if cowboy is still alive
	if (cowboy.userData.hasPlayedDeath) {
		return;
	}

	// Get cowboy's position
	const cowboyPosition = new THREE.Vector3();
	cowboy.getWorldPosition(cowboyPosition);

	// Get player's actual camera position
	const playerPos = new THREE.Vector3();
	camera.getWorldPosition(playerPos);

	// Calculate direction from cowboy to player
	const direction = new THREE.Vector3().subVectors(playerPos, cowboyPosition).normalize();

	// Create a bullet
	const bulletGeometry = new THREE.SphereGeometry(0.1, 8, 8);
	const bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
	const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);

	// Position bullet at cowboy's position
	bullet.position.copy(cowboyPosition);

	// Set bullet velocity
	const bulletSpeed = 10;
	bullet.userData = {
		velocity: direction.multiplyScalar(bulletSpeed),
		timeToLive: 5 // Bullet disappears after 5 seconds
	};

	scene.add(bullet);

	// Store bullet for updates
	if (!window.cowboyBullets) window.cowboyBullets = [];
	window.cowboyBullets.push(bullet);

	console.log('Cowboy shot at player');
}

function fireBullet(scene, position, quaternion) {
	// Check if we're using the flamethrower (weapon 1)
	if (currentWeapon === 1) {
		// Flamethrower mode - play continuous sound
		if (window.flamethrowerSound && !window.flamethrowerSound.isPlaying) {
			window.flamethrowerSound.play();
		}

		// Create flamethrower particles
		const directionVector = forwardVector.clone().applyQuaternion(quaternion);
		emitFlamethrowerParticles(position, directionVector, scene);
	} else {
		// Regular bullet mode - play laser sound
		if (laserSound.isPlaying) laserSound.stop();
		laserSound.play();

		const currentBlasterGroup = weapons[currentWeapon];
		const bulletPrototype = currentBlasterGroup.getObjectByName('bullet');

		if (bulletPrototype) {
			const bullet = bulletPrototype.clone();
			scene.add(bullet);
			bullet.position.copy(position);
			bullet.quaternion.copy(quaternion);

			const directionVector = forwardVector
				.clone()
				.applyQuaternion(bullet.quaternion);
			bullet.userData = {
				velocity: directionVector.multiplyScalar(bulletSpeed),
				timeToLive: bulletTimeToLive,
			};
			bullets[bullet.uuid] = bullet;
		} else {
			// Create bullet dynamically if no prototype exists
			const bulletGeometry = new THREE.SphereGeometry(0.05, 8, 8);
			const bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Red for weapon 0
			const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);

			scene.add(bullet);
			bullet.position.copy(position);
			bullet.quaternion.copy(quaternion);

			const directionVector = forwardVector
				.clone()
				.applyQuaternion(bullet.quaternion);
			bullet.userData = {
				velocity: directionVector.multiplyScalar(bulletSpeed),
				timeToLive: bulletTimeToLive,
			};
			bullets[bullet.uuid] = bullet;
		}
	}
}

function createRoad(scene) {
	// Create a simple road using a plane
	const roadGeometry = new THREE.PlaneGeometry(10, 2000); // Longer road
	const roadMaterial = new THREE.MeshStandardMaterial({
		color: 0x333333,
		roughness: 0.8,
		metalness: 0.2
	});

	road = new THREE.Mesh(roadGeometry, roadMaterial);
	road.rotation.x = -Math.PI / 2; // Lay flat
	road.position.y = -0.5; // Slightly below player level

	// Road markers have been removed.

	scene.add(road);
}

function createTree() {
	const tree = new THREE.Group();

	const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // SaddleBrown
	const trunkGeometry = new THREE.CylinderGeometry(0.5, 0.5, 4, 8);
	const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
	trunk.position.y = 2; // Half of height
	tree.add(trunk);

	const leavesMaterial = new THREE.MeshStandardMaterial({ color: 0x228B22 }); // ForestGreen
	const leavesGeometry = new THREE.IcosahedronGeometry(3);
	const leaves = new THREE.Mesh(leavesGeometry, leavesMaterial);
	leaves.position.y = 5; // Above the trunk
	tree.add(leaves);

	return tree;
}

function createRock() {
	const rock = new THREE.Group();
	const material = new THREE.MeshStandardMaterial({
		color: 0x888888,
		roughness: 0.9,
		flatShading: true
	});
	const geometry = new THREE.IcosahedronGeometry(1, 0);
	const mesh = new THREE.Mesh(geometry, material);

	// Randomize shape
	mesh.scale.set(
		1 + Math.random() * 0.5,
		0.8 + Math.random() * 0.4,
		1 + Math.random() * 0.5
	);

	rock.add(mesh);
	return rock;
}

function createWaterTower() {
	const tower = new THREE.Group();

	const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B4513 });

	// Tank
	const tankGeo = new THREE.CylinderGeometry(3, 3, 4, 16);
	const tank = new THREE.Mesh(tankGeo, woodMat);
	tank.position.y = 8;
	tower.add(tank);

	// Roof
	const roofGeo = new THREE.ConeGeometry(3.5, 2, 16);
	const roof = new THREE.Mesh(roofGeo, woodMat);
	roof.position.y = 11;
	tower.add(roof);

	// Legs
	for (let i = 0; i < 4; i++) {
		const legGeo = new THREE.CylinderGeometry(0.2, 0.2, 8);
		const leg = new THREE.Mesh(legGeo, woodMat);
		const angle = (i / 4) * Math.PI * 2;
		leg.position.x = Math.cos(angle) * 2;
		leg.position.z = Math.sin(angle) * 2;
		leg.position.y = 4;
		tower.add(leg);
	}

	return tower;
}

function createSaloon() {
	const saloon = new THREE.Group();
	const woodColor = 0x8B4513;
	const woodMat = new THREE.MeshStandardMaterial({ color: woodColor });

	// Main building
	const baseGeo = new THREE.BoxGeometry(8, 6, 8);
	const base = new THREE.Mesh(baseGeo, woodMat);
	base.position.y = 3;
	saloon.add(base);

	// False front
	const frontGeo = new THREE.BoxGeometry(8, 8, 0.5);
	const front = new THREE.Mesh(frontGeo, woodMat);
	front.position.set(0, 4, 4); // Front face
	saloon.add(front);

	// Porch roof
	const porchGeo = new THREE.BoxGeometry(8, 0.2, 3);
	const porch = new THREE.Mesh(porchGeo, woodMat);
	porch.position.set(0, 3.5, 5.5);
	saloon.add(porch);

	// Porch posts
	for (let x of [-3.5, 3.5]) {
		const postGeo = new THREE.CylinderGeometry(0.2, 0.2, 3.5);
		const post = new THREE.Mesh(postGeo, woodMat);
		post.position.set(x, 1.75, 6.8);
		saloon.add(post);
	}

	return saloon;
}

function createHouse() {
	const house = new THREE.Group();

	const baseMaterial = new THREE.MeshStandardMaterial({ color: 0xDEB887 }); // BurlyWood
	const baseGeometry = new THREE.BoxGeometry(5, 5, 5);
	const base = new THREE.Mesh(baseGeometry, baseMaterial);
	base.position.y = 2.5;
	house.add(base);

	const roofMaterial = new THREE.MeshStandardMaterial({ color: 0xA52A2A }); // Brown
	const roofGeometry = new THREE.ConeGeometry(4, 3, 4); // radius, height, radialSegments
	const roof = new THREE.Mesh(roofGeometry, roofMaterial);
	roof.position.y = 5 + 1.5; // On top of the base
	roof.rotation.y = Math.PI / 4; // Align pyramid edges
	house.add(roof);

	return house;
}

function createCactus() {
	const cactus = new THREE.Group();
	const green = 0x2E8B57; // SeaGreen

	// Main trunk
	const trunkGeo = new THREE.CapsuleGeometry(0.25, 2, 4, 8);
	const trunkMat = new THREE.MeshStandardMaterial({ color: green, roughness: 0.8 });
	const trunk = new THREE.Mesh(trunkGeo, trunkMat);
	trunk.position.y = 1;
	cactus.add(trunk);

	// Arms
	if (Math.random() > 0.3) {
		const arm1Geo = new THREE.CapsuleGeometry(0.15, 0.8, 4, 8);
		const arm1 = new THREE.Mesh(arm1Geo, trunkMat);
		arm1.position.set(0.3, 1.2, 0);
		arm1.rotation.z = -Math.PI / 4;
		cactus.add(arm1);
	}

	if (Math.random() > 0.3) {
		const arm2Geo = new THREE.CapsuleGeometry(0.15, 0.8, 4, 8);
		const arm2 = new THREE.Mesh(arm2Geo, trunkMat);
		arm2.position.set(-0.3, 0.8, 0);
		arm2.rotation.z = Math.PI / 4;
		cactus.add(arm2);
	}

	return cactus;
}

function populateScenery(scene) {
	// Zone 1: The Town (0 to -100)
	// Place buildings on both sides
	for (let z = -10; z > -100; z -= 25) {
		// Left side
		const saloonLeft = createSaloon();
		saloonLeft.position.set(-12, 0, z);
		saloonLeft.rotation.y = Math.PI / 2;
		scene.add(saloonLeft);
		obstacles.push(saloonLeft);

		// Right side
		const houseRight = createHouse();
		houseRight.position.set(12, 0, z);
		houseRight.rotation.y = -Math.PI / 2;
		scene.add(houseRight);
		obstacles.push(houseRight);
	}

	// Water Tower at the end of town
	const tower = createWaterTower();
	tower.position.set(15, 0, -110);
	scene.add(tower);
	obstacles.push(tower);

	// Zone 2: Wilderness (-100 to -1000)
	for (let i = 0; i < 200; i++) {
		const side = (i % 2 === 0) ? 1 : -1;
		const xPos = side * (10 + Math.random() * 50);
		const zPos = -120 - i * 10 - Math.random() * 10;

		const rand = Math.random();
		if (rand > 0.7) {
			const rock = createRock();
			rock.position.set(xPos, 0, zPos);
			rock.rotation.y = Math.random() * Math.PI;
			const scale = 1 + Math.random() * 3;
			rock.scale.setScalar(scale);
			scene.add(rock);
			obstacles.push(rock);
		} else if (rand > 0.4) {
			const cactus = createCactus();
			cactus.position.set(xPos, 0, zPos);
			cactus.rotation.y = Math.random() * Math.PI;
			scene.add(cactus);
			obstacles.push(cactus);
		} else {
			// Dead bush / small rock
			const rock = createRock();
			rock.position.set(xPos, 0, zPos);
			rock.scale.setScalar(0.5);
			scene.add(rock);
		}
	}
}

function setupScene({ scene, camera, _renderer, player, _controllers, controls }) {
	// Store global camera reference for cowboy targeting
	globalCamera = camera;

	// Sunset Atmosphere
	const fogColor = 0x874c62; // Dusty purple/red
	scene.fog = new THREE.Fog(fogColor, 20, 90); // Closer fog for atmosphere
	scene.background = new THREE.Color(fogColor);

	// Create road
	createRoad(scene);

	// Ground Plane
	const groundGeo = new THREE.PlaneGeometry(2000, 2000);
	const groundMat = new THREE.MeshStandardMaterial({
		color: 0xba8c63, // Darker sand
		roughness: 1,
		metalness: 0
	});
	const ground = new THREE.Mesh(groundGeo, groundMat);
	ground.rotation.x = -Math.PI / 2;
	ground.position.y = -0.6; // Just below the road
	scene.add(ground);

	populateScenery(scene);

	// Lighting
	const ambientLight = new THREE.AmbientLight(0x402040, 1.0); // Purple ambient
	scene.add(ambientLight);

	const sunLight = new THREE.DirectionalLight(0xffaa33, 2.0); // Orange sun
	sunLight.position.set(-50, 30, -20); // Low angle sun
	sunLight.castShadow = true;
	scene.add(sunLight);

	// Create a circle around the player
	const ringGeometry = new THREE.RingGeometry(1.9, 2, 32);
	const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
	const ring = new THREE.Mesh(ringGeometry, ringMaterial);
	ring.rotation.x = -Math.PI / 2; // Rotate it to be flat on the ground
	ring.position.y = 0.1; // Lift it slightly above the ground

	// Add the circle as a child of the player so it moves with the player
	player.add(ring);

	// Load models
	const gltfLoader = new GLTFLoader();

	gltfLoader.load('assets/blaster.glb', (gltf) => {
		blasterGroup.add(gltf.scene);
		console.log('=== RED BLASTER LOADED ===');
		console.log('Blaster group children count:', blasterGroup.children.length);
		if (blasterGroup.children.length > 0) {
			const firstChild = blasterGroup.children[0];
			console.log('First blaster child:', firstChild);
			console.log('First blaster child name:', firstChild.name);
			console.log('First blaster child type:', firstChild.type);
			console.log('First blaster child visible:', firstChild.visible);
			console.log('First blaster child children count:', firstChild.children.length);
			if (firstChild.children.length > 0) {
				console.log('First blaster grandchild:', firstChild.children[0]);
				console.log('First blaster grandchild name:', firstChild.children[0].name);
			}
		}

		// Create mouse blaster for non-VR mode
		mouseBlaster = gltf.scene.clone();
		mouseBlaster.position.set(0.3, -0.3, -0.5);
		mouseBlaster.scale.setScalar(0.8);
	});

	// Load blue weapon variant (flamethrower)
	gltfLoader.load('assets/blaster.glb', (gltf) => {
		const blueBlaster = gltf.scene.clone();

		// Modify material to make it look like a flamethrower
		blueBlaster.traverse((child) => {
			if (child.isMesh) {
				child.material = child.material.clone();
				child.material.color = new THREE.Color(0x4444ff); // Blue color
				child.material.emissive = new THREE.Color(0x000066); // Blue glow
				child.material.metalness = 0.3;
				child.material.roughness = 0.7;
			}
		});

		// Add a flame nozzle effect
		const nozzleGeometry = new THREE.ConeGeometry(0.1, 0.3, 8);
		const nozzleMaterial = new THREE.MeshBasicMaterial({
			color: 0xff4400,
			transparent: true,
			opacity: 0.7
		});
		const nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
		nozzle.rotation.x = Math.PI;
		nozzle.position.z = -0.1;
		blueBlaster.add(nozzle);

		blueBlasterGroup.add(blueBlaster);
		console.log('=== BLUE FLAMETHROWER LOADED ===');
	});

	// Load cowboy enemy
	gltfLoader.load('assets/cowboy1.glb', (gltf) => {
		cowboyGltf = gltf;
		// Spawn a single test cowboy after a short delay
		setTimeout(() => spawnCowboy(scene), 2000);
	});

	// Load and set up positional audio
	const listener = new THREE.AudioListener();
	camera.add(listener);

	const audioLoader = new THREE.AudioLoader();
	laserSound = new THREE.PositionalAudio(listener);
	audioLoader.load('assets/laser.ogg', (buffer) => {
		laserSound.setBuffer(buffer);
		blasterGroup.add(laserSound);

		// Also set up flamethrower sound using the same buffer but with different playback rate
		if (window.flamethrowerSound) {
			window.flamethrowerSound.setBuffer(buffer);
			// Set a lower playback rate for a deeper, wave-like sound
			window.flamethrowerSound.setPlaybackRate(0.7);
		}
	});

	scoreSound = new THREE.PositionalAudio(listener);
	audioLoader.load('assets/score.ogg', (buffer) => {
		scoreSound.setBuffer(buffer);
		// Score text removed, so no need to add sound to it
	});

	// Create a simple wave sound for flamethrower by modifying the laser sound
	window.flamethrowerSound = new THREE.PositionalAudio(listener);
	// We'll set the buffer when the laser sound loads

	// Mouse drag rotation variables
	let isDragging = false;
	let previousMouseX = 0;
	let previousMouseY = 0;
	let cameraRotationY = 0;
	let cameraRotationX = 0;

	// Setup mouse controls
	window.addEventListener('mousedown', (event) => {
		isDragging = true;
		previousMouseX = event.clientX;
		previousMouseY = event.clientY;

		// Disable OrbitControls when starting drag
		if (controls) {
			controls.enabled = false;
		}
	});

	window.addEventListener('mousemove', (event) => {
		// Handle camera rotation with mouse drag
		if (isDragging) {
			const deltaX = event.clientX - previousMouseX;
			const deltaY = event.clientY - previousMouseY;

			// Adjust camera rotation based on mouse movement
			cameraRotationY -= deltaX * 0.01; // Horizontal rotation
			cameraRotationX -= deltaY * 0.01; // Vertical rotation (standard - moving mouse up looks up)

			// Limit vertical rotation to prevent flipping
			cameraRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cameraRotationX));

			// Apply rotation to camera using quaternions for stability
			const quatX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), cameraRotationX);
			const quatY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), cameraRotationY);

			// Combine rotations
			camera.quaternion.copy(quatY).multiply(quatX);

			previousMouseX = event.clientX;
			previousMouseY = event.clientY;
		}

		// Also update mouse coordinates for shooting
		mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
		mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
	});

	window.addEventListener('mouseup', () => {
		isDragging = false;
	});

	window.addEventListener('click', (_event) => {
		if (!isMouseMode && mouseBlaster) {
			// Switch to mouse mode and add blaster to camera
			isMouseMode = true;
			camera.add(mouseBlaster);
		}

		if (isMouseMode && mouseBlaster) {
			// Calculate direction from blaster to mouse cursor
			raycaster.setFromCamera(mouse, camera);
			const targetPoint = new THREE.Vector3();
			raycaster.ray.at(10, targetPoint); // Project 10 units forward

			// Get blaster world position
			const blasterWorldPosition = new THREE.Vector3();
			mouseBlaster.getWorldPosition(blasterWorldPosition);

			// Calculate direction vector from blaster to target point (used for quaternion calculation)
			targetPoint.clone().sub(blasterWorldPosition).normalize();

			// Create quaternion from direction
			const quaternion = new THREE.Quaternion();
			const matrix = new THREE.Matrix4();
			matrix.lookAt(blasterWorldPosition, targetPoint, camera.up);
			quaternion.setFromRotationMatrix(matrix);

			fireBullet(scene, blasterWorldPosition, quaternion);
		}
	});

	// Re-enable OrbitControls when exiting mouse mode
	window.addEventListener('keydown', (event) => {
		if (isMouseMode && event.key === 'Escape') {
			isMouseMode = false;
			if (mouseBlaster && mouseBlaster.parent === camera) {
				camera.remove(mouseBlaster);
			}
			// Re-enable OrbitControls
			if (controls) {
				controls.enabled = true;
			}
			// Reset camera rotation
			cameraRotationY = 0;
			cameraRotationX = 0;
			camera.quaternion.set(0, 0, 0, 1); // Reset to identity quaternion
		}
	});

	// Add listeners for fly controls
	window.addEventListener('keydown', (event) => {
		keyStates[event.code] = true;
	});
	window.addEventListener('keyup', (event) => {
		keyStates[event.code] = false;
	});
}

function onFrame(
	delta,
	_time,
	{ scene, camera, _renderer, player, controllers },
) {
	// Update player position for forward movement
	const playerSpeed = 1.5; // Player walking speed
	window.playerPosition += playerSpeed * delta;

	// --- Fly Controls (replaces automatic movement) ---
	const FLY_SPEED = 10;
	const forward = new THREE.Vector3();
	const right = new THREE.Vector3();

	camera.getWorldDirection(forward);
	forward.y = 0; // Project onto horizontal plane
	forward.normalize();

	right.crossVectors(forward, camera.up); // Get the right vector

	if (keyStates['KeyW']) { // Forward
		player.position.add(forward.clone().multiplyScalar(FLY_SPEED * delta));
	}
	if (keyStates['KeyS']) { // Backward
		player.position.add(forward.clone().multiplyScalar(-FLY_SPEED * delta));
	}
	if (keyStates['KeyA']) { // Left (strafe)
		player.position.add(right.clone().multiplyScalar(-FLY_SPEED * delta));
	}
	if (keyStates['KeyD']) { // Right (strafe)
		player.position.add(right.clone().multiplyScalar(FLY_SPEED * delta));
	}

	// Update player position tracking
	window.playerPosition = -player.position.z;

	// Move the road and background to stay centered on the player
	if (road) {
		road.position.z = -window.playerPosition;
	}
	if (backgroundPlane) {
		backgroundPlane.position.z = -window.playerPosition - 150;
	}

	// Update cowboys: movement, orientation, and animations
	for (let i = 0; i < cowboys.length; i++) {
		const cowboy = cowboys[i];
		const cowboyData = cowboyMixers[i];

		// Skip logic for cowboys that are "dead" and animating
		if (cowboy.userData.hasPlayedDeath) {
			continue;
		}

		// --- Orientation ---
		const playerTargetPosition = new THREE.Vector3();
		camera.getWorldPosition(playerTargetPosition);
		const lookAtTarget = new THREE.Vector3(
			playerTargetPosition.x,
			cowboy.position.y,
			playerTargetPosition.z,
		);
		cowboy.lookAt(lookAtTarget);

		// --- Movement & Animation ---
		const distanceToPlayer = cowboy.position.distanceTo(playerTargetPosition);
		let moveDirection = new THREE.Vector3();
		let speed = 0;

		if (distanceToPlayer > WALK_THRESHOLD) {
			moveDirection.subVectors(lookAtTarget, cowboy.position).normalize();
			speed = RUN_SPEED;
			// Switch to run animation
			if (cowboyData.runAction) {
				if (cowboyData.currentAction !== cowboyData.runAction) {
					if (cowboyData.currentAction) {
						cowboyData.currentAction.fadeOut(0.3);
					}
					cowboyData.runAction.reset().fadeIn(0.3).play();
					cowboyData.currentAction = cowboyData.runAction;
				}
			} else if (cowboyData.idleAction) {
				// Fallback to idle if no run animation
				if (cowboyData.currentAction !== cowboyData.idleAction) {
					if (cowboyData.currentAction) {
						cowboyData.currentAction.fadeOut(0.3);
					}
					cowboyData.idleAction.reset().fadeIn(0.3).play();
					cowboyData.currentAction = cowboyData.idleAction;
				}
			}

		} else if (distanceToPlayer > ATTACK_THRESHOLD) {
			moveDirection.subVectors(lookAtTarget, cowboy.position).normalize();
			speed = WALK_SPEED;
			// Switch to walk animation
			if (cowboyData.walkAction) {
				if (cowboyData.currentAction !== cowboyData.walkAction) {
					if (cowboyData.currentAction) {
						cowboyData.currentAction.fadeOut(0.3);
					}
					cowboyData.walkAction.reset().fadeIn(0.3).play();
					cowboyData.currentAction = cowboyData.walkAction;
				}
			} else if (cowboyData.idleAction) {
				// Fallback to idle if no walk animation
				if (cowboyData.currentAction !== cowboyData.idleAction) {
					if (cowboyData.currentAction) {
						cowboyData.currentAction.fadeOut(0.3);
					}
					cowboyData.idleAction.reset().fadeIn(0.3).play();
					cowboyData.currentAction = cowboyData.idleAction;
				}
			}

		} else {
			speed = 0;
			// Switch to idle animation
			if (cowboyData.idleAction) {
				if (cowboyData.currentAction !== cowboyData.idleAction) {
					if (cowboyData.currentAction) {
						cowboyData.currentAction.fadeOut(0.3);
					}
					cowboyData.idleAction.reset().fadeIn(0.3).play();
					cowboyData.currentAction = cowboyData.idleAction;
				}
			}
		}

		// --- Collision Avoidance ---
		const avoidanceVector = new THREE.Vector3();
		// Avoid other cowboys
		for (let j = 0; j < cowboys.length; j++) {
			if (i === j) continue; // Don't check against self

			const otherCowboy = cowboys[j];
			// Only avoid cowboys that are also alive
			if (otherCowboy.userData.hasPlayedDeath) continue;

			const distanceToOther = cowboy.position.distanceTo(otherCowboy.position);

			if (distanceToOther < AVOIDANCE_RADIUS) {
				const awayVector = new THREE.Vector3().subVectors(cowboy.position, otherCowboy.position).normalize();
				avoidanceVector.add(awayVector);
			}
		}

		// Avoid obstacles (trees, houses)
		for (const obstacle of obstacles) {
			const distanceToObstacle = cowboy.position.distanceTo(obstacle.position);
			if (distanceToObstacle < OBSTACLE_AVOIDANCE_RADIUS) {
				const awayVector = new THREE.Vector3().subVectors(cowboy.position, obstacle.position).normalize();
				avoidanceVector.add(awayVector);
			}
		}

		// Combine movement and avoidance vectors
		const intendedMove = moveDirection.multiplyScalar(speed);
		const avoidanceMove = avoidanceVector.multiplyScalar(AVOIDANCE_STRENGTH);

		const totalMove = new THREE.Vector3().add(intendedMove).add(avoidanceMove);

		// Apply the final movement
		cowboy.position.add(totalMove.multiplyScalar(delta));
	}

	// Spawn new cowboys periodically
	if (cowboyGltf && cowboys.length < 20 && Math.random() < 0.1) {
		spawnCowboy(scene);
	}

	// Remove cowboys that are too far behind
	for (let i = cowboys.length - 1; i >= 0; i--) {
		const cowboy = cowboys[i];
		if (cowboy.position.z > -window.playerPosition + 15) { // 15 units behind player
			// Clear the shooting interval
			if (cowboy.userData.shootInterval) {
				clearInterval(cowboy.userData.shootInterval);
			}
			scene.remove(cowboy);
			cowboys.splice(i, 1);
			if (cowboyMixers[i]) {
				cowboyMixers.splice(i, 1);
			}
		}
	}

	// Check if we're in VR mode or mouse mode
	const isInVR = controllers.right && controllers.right.gamepad;

	if (isInVR) {
		// VR Mode - hide mouse blaster if it's visible
		if (isMouseMode && mouseBlaster && mouseBlaster.parent === camera) {
			camera.remove(mouseBlaster);
			isMouseMode = false;
		}

		const { gamepad, raySpace, mesh } = controllers.right;
		// Add the current weapon to the controller (start with red weapon)
		if (!raySpace.children.includes(weapons[currentWeapon])) {
			raySpace.add(weapons[currentWeapon]);
			mesh.visible = false;
		}

		// Handle thumbstick movement
		if (controllers.left && controllers.left.gamepad) {
			const leftGamepad = controllers.left.gamepad;
			const thumbstickX = leftGamepad.getAxis(XR_AXES.THUMBSTICK_X);
			const thumbstickY = leftGamepad.getAxis(XR_AXES.THUMBSTICK_Y);

			// Only move if thumbstick is pushed beyond deadzone
			if (Math.abs(thumbstickX) > 0.1 || Math.abs(thumbstickY) > 0.1) {
				const moveSpeed = 5.0;
				const moveX = thumbstickX * moveSpeed * delta;
				const moveZ = -thumbstickY * moveSpeed * delta; // Invert Y axis for natural forward/backward movement

				// Get player's current rotation to move in the correct direction
				const playerDirection = new THREE.Vector3();
				camera.getWorldDirection(playerDirection);
				playerDirection.y = 0;
				playerDirection.normalize();

				// Calculate strafe direction (perpendicular to forward)
				const strafeDirection = new THREE.Vector3();
				strafeDirection.crossVectors(playerDirection, camera.up);

				// Apply movement
				player.position.x += moveX * strafeDirection.x + moveZ * playerDirection.x;
				player.position.z += moveX * strafeDirection.z + moveZ * playerDirection.z;

				// Update player position tracking
				window.playerPosition = -player.position.z;
			}
		}

		// Handle right thumbstick rotation
		if (gamepad) {
			const rightThumbstickX = gamepad.getAxis(XR_AXES.THUMBSTICK_X);

			// Only rotate if thumbstick is pushed beyond deadzone
			if (Math.abs(rightThumbstickX) > 0.1) {
				const rotateSpeed = 2.0;
				const rotationDelta = -rightThumbstickX * rotateSpeed * delta; // Invert for natural rotation

				// Rotate the player around the Y axis
				player.rotateY(rotationDelta);
			}

			// Handle weapon switching with button press (using BUTTON_1, typically the A button)
			if (gamepad.getButtonDown(XR_BUTTONS.BUTTON_1)) {
				// Switch weapon
				currentWeapon = (currentWeapon + 1) % weapons.length;
				const weaponNames = ['Blaster', 'Flamethrower'];
				console.log('Switched to weapon:', weaponNames[currentWeapon]);

				// Update the weapon model shown in the player's hand
				if (raySpace.children.includes(blasterGroup)) {
					raySpace.remove(blasterGroup);
				}
				if (raySpace.children.includes(blueBlasterGroup)) {
					raySpace.remove(blueBlasterGroup);
				}

				// Add the current weapon to the controller
				raySpace.add(weapons[currentWeapon]);
			}

			// Handle continuous fire (dauerfeuer) when trigger is held
			if (gamepad.getButton(XR_BUTTONS.TRIGGER)) {
				// Check if we should fire (implementing a fire rate limit)
				if (!gamepad.userData) gamepad.userData = {};
				if (!gamepad.userData.lastFireTime) gamepad.userData.lastFireTime = 0;

				const currentTime = Date.now();
				// Different fire rates for different weapons
				const fireRate = currentWeapon === 1 ? 50 : 150; // Faster for flamethrower

				if (currentTime - gamepad.userData.lastFireTime > fireRate) {
					try {
						// Different haptic feedback for different weapons
						const intensity = currentWeapon === 1 ? 0.2 : 0.3;
						const duration = currentWeapon === 1 ? 30 : 50;
						gamepad.getHapticActuator(0).pulse(intensity, duration);
					} catch {
						// do nothing
					}

					const blasterWorldPosition = new THREE.Vector3();
					const blasterWorldQuaternion = new THREE.Quaternion();
					weapons[currentWeapon].getWorldPosition(blasterWorldPosition);
					weapons[currentWeapon].getWorldQuaternion(blasterWorldQuaternion);

					fireBullet(scene, blasterWorldPosition, blasterWorldQuaternion);
					gamepad.userData.lastFireTime = currentTime;
				}
			} else {
				// Trigger released - stop flamethrower sound if it's playing
				if (currentWeapon === 1 && window.flamethrowerSound && window.flamethrowerSound.isPlaying) {
					window.flamethrowerSound.stop();
				}
			}
		}
	} else {
		// Non-VR Mode - show mouse blaster if not already visible
		if (!isMouseMode && mouseBlaster && mouseBlaster.parent !== camera) {
			camera.add(mouseBlaster);
			isMouseMode = true;
		}
	}

	Object.values(bullets).forEach((bullet) => {
		if (bullet.userData.timeToLive < 0) {
			console.log('Bullet TTL expired, removing bullet:', bullet.uuid);
			delete bullets[bullet.uuid];
			scene.remove(bullet);
			return;
		}
		const deltaVec = bullet.userData.velocity.clone().multiplyScalar(delta);
		bullet.position.add(deltaVec);
		bullet.userData.timeToLive -= delta;

		let bulletHit = false;

		// Check collision with cowboys
		if (!bulletHit) {
			cowboys.forEach((cowboy, index) => {
				if (bulletHit) {
					console.log('Skipping cowboy check - bullet already hit something');
					return;
				}
				const distance = cowboy.position.distanceTo(bullet.position);
				// Increased hitbox size for better collision detection
				if (distance < 2.0) {
					console.log('Cowboy collision detected! Distance:', distance, 'Index:', index);
					console.log('Cowboy position:', cowboy.position);
					console.log('Bullet position:', bullet.position);
					console.log('Cowboys array length before removal:', cowboys.length);
					bulletHit = true;

					// Play death animation if available
					const cowboyData = cowboyMixers[index];
					if (cowboyData && cowboyData.mixer && cowboy.userData && cowboy.userData.deathAction && !cowboy.userData.hasPlayedDeath) {
						console.log('Playing death animation in place');
						cowboy.userData.hasPlayedDeath = true;

						// Stop current idle animation
						if (cowboy.userData.idleAction) {
							cowboy.userData.idleAction.stop();
						}

						// Play death animation
						const deathAction = cowboy.userData.deathAction;
						deathAction.setLoop(THREE.LoopOnce, 1);
						deathAction.clampWhenFinished = true;
						deathAction.play();

						// Remove bullet but keep cowboy visible during death animation
						console.log('Removing bullet from bullets object and scene');
						delete bullets[bullet.uuid];
						scene.remove(bullet);

						// After death animation completes, remove cowboy
						setTimeout(() => {
							console.log('Death animation complete, removing cowboy from scene');

							// Find the current index of the cowboy, as it may have changed
							const currentIndex = cowboys.indexOf(cowboy);
							if (currentIndex === -1) {
								// Cowboy already removed, do nothing
								return;
							}

							// Clear the shooting interval
							if (cowboy.userData.shootInterval) {
								clearInterval(cowboy.userData.shootInterval);
							}

							scene.remove(cowboy);
							cowboys.splice(currentIndex, 1);
							console.log('Cowboys array length after removal:', cowboys.length);

							// Remove corresponding mixer data at the same index
							cowboyMixers.splice(currentIndex, 1);

						}, 4000); // Wait 4 seconds total for death animation

					} else {
						// No death animation available, remove immediately
						console.log('No death animation available, removing immediately');
						console.log('Removing bullet from bullets object and scene');
						delete bullets[bullet.uuid];
						scene.remove(bullet);
						console.log('Removing cowboy from scene');
						// Clear the shooting interval
						if (cowboy.userData.shootInterval) {
							clearInterval(cowboy.userData.shootInterval);
						}
						scene.remove(cowboy);
						cowboys.splice(index, 1);
						console.log('Cowboys array length after removal:', cowboys.length);

						// Remove corresponding mixer data
						if (cowboyMixers[index]) {
							cowboyMixers.splice(index, 1);
						}
					}

					// Score display removed - no need to update score
					console.log('Cowboy hit processing complete');
				}
			});
		}
	});

	// Update cowboy animations
	cowboyMixers.forEach(cowboyData => {
		if (cowboyData.mixer) {
			cowboyData.mixer.update(delta);
		}
	});

	// Update cowboy bullets
	if (window.cowboyBullets) {
		for (let i = window.cowboyBullets.length - 1; i >= 0; i--) {
			const bullet = window.cowboyBullets[i];

			// Update bullet position
			bullet.position.add(bullet.userData.velocity.clone().multiplyScalar(delta));

			// Update TTL
			bullet.userData.timeToLive -= delta;

			// Remove bullet if TTL expired
			if (bullet.userData.timeToLive <= 0) {
				scene.remove(bullet);
				window.cowboyBullets.splice(i, 1);
			}

			// TODO: Add collision detection with player
		}
	}

	// Update flamethrower particles
	updateFlamethrowerParticles(delta, scene);

	gsap.ticker.tick(delta);
}

function createFlamethrowerParticle() {
	// Reuse particles from pool if available
	if (flamethrowerParticlePool.length > 0) {
		return flamethrowerParticlePool.pop();
	}

	// Create new particle - even smaller size for better effect
	const geometry = new THREE.SphereGeometry(0.01, 3, 3);
	const material = new THREE.MeshBasicMaterial({
		color: new THREE.Color(
			Math.random() * 0.5 + 0.5, // Red component (0.5 - 1.0)
			Math.random() * 0.3,       // Green component (0.0 - 0.3)
			0                          // Blue component (0.0)
		),
		transparent: true,
		opacity: 0.9
	});
	const particle = new THREE.Mesh(geometry, material);

	particle.userData = {
		velocity: new THREE.Vector3(),
		lifetime: 0,
		maxLifetime: 0,
		isFlame: true // Mark as flame particle for collision detection
	};

	return particle;
}

function updateFlamethrowerParticles(delta, scene) {
	for (let i = flamethrowerParticles.length - 1; i >= 0; i--) {
		const particle = flamethrowerParticles[i];

		// Update particle
		particle.position.add(particle.userData.velocity.clone().multiplyScalar(delta));

		// Update lifetime
		particle.userData.lifetime += delta;

		// Fade out as particle ages
		const lifeRatio = particle.userData.lifetime / particle.userData.maxLifetime;
		particle.material.opacity = 0.8 * (1 - lifeRatio);

		// Randomly flicker color
		if (Math.random() < 0.1) {
			particle.material.color = new THREE.Color(
				Math.random() * 0.5 + 0.5, // Red
				Math.random() * 0.3,       // Green
				0                          // Blue
			);
		}

		// Check collision with cowboys
		for (let j = cowboys.length - 1; j >= 0; j--) {
			const cowboy = cowboys[j];
			if (cowboy.userData.hasPlayedDeath) continue;

			const distance = cowboy.position.distanceTo(particle.position);
			// Smaller hitbox for flamethrower (particles are small)
			if (distance < 1.0) {
				// Kill the cowboy
				const cowboyData = cowboyMixers[j];
				if (cowboyData && cowboyData.mixer && cowboy.userData && cowboy.userData.deathAction && !cowboy.userData.hasPlayedDeath) {
					console.log('Cowboy hit by flamethrower! Distance:', distance);
					cowboy.userData.hasPlayedDeath = true;

					// Stop current idle animation
					if (cowboy.userData.idleAction) {
						cowboy.userData.idleAction.stop();
					}

					// Play death animation
					const deathAction = cowboy.userData.deathAction;
					deathAction.setLoop(THREE.LoopOnce, 1);
					deathAction.clampWhenFinished = true;
					deathAction.play();

					// Clear the shooting interval
					if (cowboy.userData.shootInterval) {
						clearInterval(cowboy.userData.shootInterval);
					}

					// Increase score
					// Score display removed - no need to update score

					// Remove the particle that hit the cowboy
					scene.remove(particle);
					flamethrowerParticlePool.push(particle);
					flamethrowerParticles.splice(i, 1);

					// After death animation completes, remove cowboy
					setTimeout(() => {
						// Find the current index of the cowboy, as it may have changed
						const currentIndex = cowboys.indexOf(cowboy);
						if (currentIndex === -1) {
							// Cowboy already removed, do nothing
							return;
						}

						// Clear the shooting interval
						if (cowboy.userData.shootInterval) {
							clearInterval(cowboy.userData.shootInterval);
						}

						scene.remove(cowboy);
						cowboys.splice(currentIndex, 1);
						console.log('Cowboys array length after removal:', cowboys.length);

						// Remove corresponding mixer data at the same index
						cowboyMixers.splice(currentIndex, 1);

					}, 4000); // Wait 4 seconds total for death animation

					break; // Break since this particle is now gone
				}
			}
		}

		// Remove dead particles
		if (particle.userData.lifetime >= particle.userData.maxLifetime) {
			scene.remove(particle);
			flamethrowerParticlePool.push(particle);
			flamethrowerParticles.splice(i, 1);
		}
	}
}

function emitFlamethrowerParticles(position, direction, scene) {
	// Emit multiple particles per call for flame effect
	const particleCount = 8; // More particles for denser flame

	for (let i = 0; i < particleCount; i++) {
		if (flamethrowerParticles.length >= maxFlamethrowerParticles) {
			// Don't create more particles if we've hit the limit
			break;
		}

		const particle = createFlamethrowerParticle();

		// Position particle at weapon nozzle with slight randomness
		particle.position.copy(position);
		particle.position.x += (Math.random() - 0.5) * 0.05;
		particle.position.y += (Math.random() - 0.5) * 0.05;
		particle.position.z += (Math.random() - 0.5) * 0.05;

		// Set velocity with spread
		const spread = 0.2; // Tighter spread for more focused flame
		particle.userData.velocity.copy(direction);
		particle.userData.velocity.x += (Math.random() - 0.5) * spread;
		particle.userData.velocity.y += (Math.random() - 0.5) * spread;
		particle.userData.velocity.z += (Math.random() - 0.5) * spread;

		// Scale velocity for flamethrower effect - faster particles
		particle.userData.velocity.multiplyScalar(8 + Math.random() * 7);

		// Set lifetime - shorter for more dynamic effect
		particle.userData.maxLifetime = 0.3 + Math.random() * 0.3;
		particle.userData.lifetime = 0;

		scene.add(particle);
		flamethrowerParticles.push(particle);
	}
}

init(setupScene, onFrame);