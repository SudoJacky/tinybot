import "./LoadingState.css";

export function LoadingState({ label, fill = false }: { label: string; fill?: boolean }) {
  return (
    <div className={`react-loading-state${fill ? " react-loading-state--fill" : ""}`} role="status">
      <img src="/assets/logo-mark.svg" width="80" height="80" alt="" />
      <span className="react-loading-state__label">{label}</span>
    </div>
  );
}
