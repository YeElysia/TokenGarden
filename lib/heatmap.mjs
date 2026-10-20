/** Positive-day quartiles; missing and zero days never shift the distribution.
 * @param {number[]} values */
export function heatScale(values) {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const quantile = (p) => {
    const index = (sorted.length - 1) * p,
      lower = Math.floor(index),
      fraction = index - lower;
    return sorted.length
      ? sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * fraction
      : 0;
  };
  const cuts = [quantile(0.25), quantile(0.5), quantile(0.75)];
  return (value) =>
    value <= 0
      ? 0
      : value <= cuts[0]
        ? 1
        : value <= cuts[1]
          ? 2
          : value <= cuts[2]
            ? 3
            : 4;
}
