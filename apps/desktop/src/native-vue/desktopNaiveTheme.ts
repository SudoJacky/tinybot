import type { GlobalThemeOverrides } from "naive-ui";

export const desktopNaiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    borderRadius: "8px",
    borderRadiusSmall: "6px",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
    fontFamilyMono: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace",
    primaryColor: "#cc785c",
    primaryColorHover: "#a9583e",
    primaryColorPressed: "#a9583e",
    primaryColorSuppl: "#cc785c",
    textColorBase: "#141413",
    textColor1: "#141413",
    textColor2: "#3d3d3a",
    textColor3: "#6c6a64",
  },
  Button: {
    borderRadiusMedium: "8px",
    fontWeight: "600",
  },
};
