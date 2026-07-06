import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { gsap } from "gsap";
import "./TextType.css";

export type TextTypeProps = {
  ariaHidden?: boolean;
  ariaLabel?: string;
  as?: ElementType;
  className?: string;
  cursorBlinkDuration?: number;
  cursorCharacter?: ReactNode;
  cursorClassName?: string;
  deletingSpeed?: number;
  hideCursorWhileTyping?: boolean;
  initialDelay?: number;
  loop?: boolean;
  onSentenceComplete?: (sentence: string, index: number) => void;
  pauseDuration?: number;
  reverseMode?: boolean;
  showCursor?: boolean;
  startOnVisible?: boolean;
  text: string | readonly string[];
  textColors?: string[];
  typingSpeed?: number;
  variableSpeed?: { min: number; max: number };
};

export function TextType({
  ariaHidden = false,
  ariaLabel,
  as: Component = "span",
  className = "",
  cursorBlinkDuration = 0.5,
  cursorCharacter = "|",
  cursorClassName = "",
  deletingSpeed = 30,
  hideCursorWhileTyping = false,
  initialDelay = 0,
  loop = true,
  onSentenceComplete,
  pauseDuration = 2000,
  reverseMode = false,
  showCursor = true,
  startOnVisible = false,
  text,
  textColors = [],
  typingSpeed = 50,
  variableSpeed,
}: TextTypeProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(!startOnVisible);
  const cursorRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const textKeyRef = useRef("");
  const switchingTextRef = useRef(false);

  const textArray = useMemo(() => Array.isArray(text) ? [...text] : [text], [text]);
  const currentText = textArray[currentTextIndex] ?? "";
  const processedText = reverseMode ? currentText.split("").reverse().join("") : currentText;
  const reducedMotion = prefersReducedMotion();

  const getRandomSpeed = useCallback(() => {
    if (!variableSpeed) {
      return typingSpeed;
    }
    return Math.random() * (variableSpeed.max - variableSpeed.min) + variableSpeed.min;
  }, [typingSpeed, variableSpeed]);

  const textKey = textArray.join("\u0000");

  useEffect(() => {
    if (!textKeyRef.current) {
      textKeyRef.current = textKey;
      return;
    }
    if (textKeyRef.current === textKey) {
      return;
    }
    textKeyRef.current = textKey;
    setCurrentTextIndex(0);
    setCurrentCharIndex(0);
    if (displayedText) {
      switchingTextRef.current = true;
      setIsDeleting(true);
      return;
    }
    setIsDeleting(false);
  }, [displayedText, textKey]);

  useEffect(() => {
    if (!startOnVisible || !containerRef.current) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      }
    }, { threshold: 0.1 });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [startOnVisible]);

  useEffect(() => {
    if (!showCursor || reducedMotion || !cursorRef.current) {
      return;
    }
    gsap.set(cursorRef.current, { opacity: 1 });
    const tween = gsap.to(cursorRef.current, {
      duration: cursorBlinkDuration,
      ease: "power2.inOut",
      opacity: 0,
      repeat: -1,
      yoyo: true,
    });
    return () => {
      tween.kill();
    };
  }, [cursorBlinkDuration, reducedMotion, showCursor]);

  useEffect(() => {
    if (reducedMotion) {
      setDisplayedText(processedText);
      return;
    }
    if (!isVisible || !processedText) {
      return;
    }
    let timeout: number | undefined;

    if (isDeleting) {
      if (displayedText === "") {
        setIsDeleting(false);
        if (switchingTextRef.current) {
          switchingTextRef.current = false;
          setCurrentCharIndex(0);
          return;
        }
        onSentenceComplete?.(currentText, currentTextIndex);
        if (currentTextIndex === textArray.length - 1 && !loop) {
          return;
        }
        setCurrentTextIndex((index) => (index + 1) % textArray.length);
        setCurrentCharIndex(0);
        return;
      }
      timeout = window.setTimeout(() => {
        setDisplayedText((value) => value.slice(0, -1));
      }, deletingSpeed);
      return () => window.clearTimeout(timeout);
    }

    if (currentCharIndex < processedText.length) {
      timeout = window.setTimeout(() => {
        setDisplayedText((value) => value + processedText[currentCharIndex]);
        setCurrentCharIndex((index) => index + 1);
      }, currentCharIndex === 0 && displayedText === "" ? initialDelay : (variableSpeed ? getRandomSpeed() : typingSpeed));
      return () => window.clearTimeout(timeout);
    }

    if (!loop && currentTextIndex === textArray.length - 1) {
      return;
    }
    timeout = window.setTimeout(() => {
      setIsDeleting(true);
    }, pauseDuration);
    return () => window.clearTimeout(timeout);
  }, [
    currentCharIndex,
    currentText,
    currentTextIndex,
    deletingSpeed,
    displayedText,
    getRandomSpeed,
    initialDelay,
    isDeleting,
    isVisible,
    loop,
    onSentenceComplete,
    pauseDuration,
    processedText,
    reducedMotion,
    textArray.length,
    typingSpeed,
    variableSpeed,
  ]);

  const currentColor = textColors.length ? textColors[currentTextIndex % textColors.length] : undefined;
  const shouldHideCursor = hideCursorWhileTyping && (currentCharIndex < processedText.length || isDeleting);

  return createElement(
    Component,
    {
      "aria-hidden": ariaHidden || undefined,
      "aria-label": ariaHidden ? undefined : ariaLabel,
      className: ["text-type", className].filter(Boolean).join(" "),
      "data-text-type": loop ? "loop" : "once",
      "data-testid": "text-type",
      ref: containerRef,
    },
    <span className="text-type__content" data-testid="text-type-visual" style={{ color: currentColor ?? "inherit" }}>
      {displayedText}
    </span>,
    showCursor && !reducedMotion ? (
      <span
        aria-hidden="true"
        className={["text-type__cursor", cursorClassName, shouldHideCursor ? "text-type__cursor--hidden" : ""].filter(Boolean).join(" ")}
        ref={cursorRef}
      >
        {cursorCharacter}
      </span>
    ) : null,
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default TextType;
