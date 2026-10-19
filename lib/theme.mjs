export function getTimeTheme(date = new Date()) {
  const hour = date.getHours();
  return hour >= 7 && hour < 19 ? "wuling" : "night";
}

export const themeInitScript = `document.documentElement.dataset.theme = (${getTimeTheme.toString()})();`;
