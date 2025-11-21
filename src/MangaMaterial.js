import * as THREE from 'three';

const mangaVertexShader = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
}
`;

const mangaFragmentShader = `
uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
    // Sample texture
    vec4 texColor = texture2D(map, vUv);
    
    // Calculate brightness (luminance)
    float luminance = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
    
    // Step function for high contrast (threshold at 0.5)
    float contrast = step(0.4, luminance);
    
    // Rim lighting for outlines
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float rim = 1.0 - max(dot(normal, viewDir), 0.0);
    float rimThreshold = 0.7;
    float rimFactor = step(rimThreshold, rim);
    
    // Combine: Black ink (0.0) or White paper (1.0)
    // If it's dark OR it's an edge, make it black. Otherwise white.
    // Inverting logic: 
    // We want white (1.0) if it's bright AND NOT an edge.
    
    float finalVal = contrast * (1.0 - rimFactor);
    
    // Apply base color tint if needed (mostly ignored for B&W)
    gl_FragColor = vec4(vec3(finalVal), opacity);
}
`;

export function createMangaMaterial(originalMaterial) {
    const uniforms = {
        map: { value: originalMaterial.map || new THREE.Texture() },
        color: { value: originalMaterial.color || new THREE.Color(1, 1, 1) },
        opacity: { value: originalMaterial.opacity || 1.0 }
    };

    const material = new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: mangaVertexShader,
        fragmentShader: mangaFragmentShader,
        transparent: originalMaterial.transparent,
        side: originalMaterial.side
    });

    return material;
}
