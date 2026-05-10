export function getStoredValue(key, fallback = null) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value;
}

export function setStoredValue(key, value) {
  localStorage.setItem(key, value);
}
