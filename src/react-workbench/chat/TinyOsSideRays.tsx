import { useEffect, useRef } from "react";
import { Mesh, Program, Renderer, Triangle } from "ogl";

const VERTEX_SHADER = `
attribute vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform vec3 iRayColor1;
uniform vec3 iRayColor2;
uniform float iSpeed;
uniform float iIntensity;
uniform float iSpread;
uniform float iTilt;
uniform float iSaturation;
uniform float iBlend;
uniform float iFalloff;
uniform float iOpacity;

float rayStrength(vec2 source, vec2 direction, vec2 coord, float seedA, float seedB, float speed) {
  vec2 sourceToCoord = coord - source;
  float cosAngle = dot(normalize(sourceToCoord), direction);
  float movement =
    (0.42 + 0.23 * sin(cosAngle * seedA + iTime * speed)) +
    (0.28 + 0.28 * cos(-cosAngle * seedB + iTime * speed));

  return clamp(movement, 0.0, 1.0) *
    clamp((iResolution.x - length(sourceToCoord)) / iResolution.x, 0.5, 1.0);
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
  vec2 rayPosition = vec2(iResolution.x * 1.1, -0.5 * iResolution.y);
  vec2 relativeCoord = coord - rayPosition;
  float tilt = iTilt * 3.14159265 / 180.0;
  vec2 tiltedCoord = vec2(
    relativeCoord.x * cos(tilt) - relativeCoord.y * sin(tilt),
    relativeCoord.x * sin(tilt) + relativeCoord.y * cos(tilt)
  ) + rayPosition;
  float halfSpread = iSpread * 0.275;
  vec2 direction1 = normalize(vec2(cos(0.785398 + halfSpread), sin(0.785398 + halfSpread)));
  vec2 direction2 = normalize(vec2(cos(0.785398 - halfSpread), sin(0.785398 - halfSpread)));
  float cyanShift = 0.17 + 0.09 * sin(iTime * 0.31);
  float violetShift = 0.14 + 0.08 * cos(iTime * 0.24);
  vec3 cyanColor = mix(iRayColor1, vec3(0.376, 0.647, 0.980), cyanShift);
  vec3 violetColor = mix(iRayColor2, vec3(0.957, 0.447, 0.714), violetShift);
  vec4 ray1 = vec4(cyanColor, 1.0) * rayStrength(rayPosition, direction1, tiltedCoord, 36.2214, 21.11349, iSpeed);
  vec4 ray2 = vec4(violetColor, 1.0) * rayStrength(rayPosition, direction2, tiltedCoord, 22.3991, 18.0234, iSpeed * 0.2);
  vec4 color = ray1 * (1.0 - iBlend) * 0.9 + ray2 * iBlend * 0.9;
  float distanceToLight = length(fragCoord - vec2(rayPosition.x, iResolution.y - rayPosition.y)) / iResolution.y;
  float brightness = iIntensity * 0.4 / pow(max(distanceToLight, 0.001), iFalloff);

  color.rgb *= brightness;
  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  color.rgb = mix(vec3(gray), color.rgb, iSaturation);
  color.a = max(color.r, max(color.g, color.b)) * iOpacity;
  gl_FragColor = color;
}
`;

export function TinyOsSideRays() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window.WebGLRenderingContext === "undefined") return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        alpha: true,
        antialias: false,
        dpr: Math.min(window.devicePixelRatio, 1.5),
      });
    } catch (error) {
      console.warn("TinyOS Side Rays could not initialize WebGL; the static background will remain active.", error);
      return;
    }

    const { gl } = renderer;
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.height = "100%";
    canvas.style.width = "100%";
    container.appendChild(canvas);

    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      iRayColor1: { value: [94 / 255, 234 / 255, 212 / 255] },
      iRayColor2: { value: [167 / 255, 139 / 255, 250 / 255] },
      iSpeed: { value: 2 },
      iIntensity: { value: 1.7 },
      iSpread: { value: 2 },
      iTilt: { value: 0 },
      iSaturation: { value: 1.4 },
      iBlend: { value: .7 },
      iFalloff: { value: 1.6 },
      iOpacity: { value: .85 },
    };
    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      fragment: FRAGMENT_SHADER,
      uniforms,
      vertex: VERTEX_SHADER,
    });
    const mesh = new Mesh(gl, { geometry, program });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animationFrame = 0;
    let running = false;

    const draw = (time = 0) => {
      uniforms.iTime.value = time * .001;
      renderer.render({ scene: mesh });
    };
    const renderFrame = (time: number) => {
      if (!running) return;
      draw(time);
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const start = () => {
      if (reducedMotion || running || document.hidden) return;
      running = true;
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const stop = () => {
      running = false;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
    const updateSize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.dpr = Math.min(window.devicePixelRatio, 1.5);
      renderer.setSize(width, height);
      uniforms.iResolution.value = [width * renderer.dpr, height * renderer.dpr];
      draw();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) start();
      else stop();
    }, { threshold: .05 });
    const resizeObserver = new ResizeObserver(updateSize);

    updateSize();
    visibilityObserver.observe(container);
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      geometry.remove();
      program.remove();
      const loseContext = gl.getExtension("WEBGL_lose_context");
      loseContext?.loseContext();
      canvas.remove();
    };
  }, []);

  return <div aria-hidden="true" className="tinyos-desktop__side-rays" ref={containerRef} />;
}
