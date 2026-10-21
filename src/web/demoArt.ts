// The fictional store's product photos, drawn: a ceramic piece on a plain backdrop, its
// shape and glaze picked from the product's handle, so the demo and the screenshots show
// pictures without any real store's images.

const GLAZES = ['#b4532a', '#2e5e4e', '#c9b79c', '#6b7b8c', '#8a5a44', '#3f5a73', '#d8c3a5'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const SHAPES: Record<string, string> = {
  mug: '<path d="M120 150h140v120a40 40 0 0 1-40 40h-60a40 40 0 0 1-40-40z" fill="G"/><path d="M260 180h18a32 32 0 0 1 0 64h-18" fill="none" stroke="G" stroke-width="18"/>',
  bowl: '<path d="M90 180h220a110 110 0 0 1-220 0z" fill="G"/><ellipse cx="200" cy="180" rx="110" ry="18" fill="#000" opacity=".12"/>',
  plate: '<ellipse cx="200" cy="215" rx="140" ry="44" fill="G"/><ellipse cx="200" cy="208" rx="96" ry="26" fill="#fff" opacity=".18"/>',
  vase: '<path d="M170 90h60v30c40 30 50 80 40 130-8 40-30 60-70 60s-62-20-70-60c-10-50 0-100 40-130z" fill="G"/>',
  jug: '<path d="M150 100h90l20 40c10 60 10 120-20 160h-90c-30-40-30-100-20-160z" fill="G"/><path d="M262 150c40 0 40 70 0 80" fill="none" stroke="G" stroke-width="16"/>',
  pot: '<path d="M120 140h160l-20 150h-120z" fill="G"/><path d="M110 120h180v26H110z" fill="G"/>',
  dish: '<ellipse cx="200" cy="220" rx="90" ry="30" fill="G"/><ellipse cx="200" cy="214" rx="62" ry="16" fill="#fff" opacity=".2"/>',
  card: '<rect x="110" y="140" width="180" height="120" rx="14" fill="G"/><path d="M110 185h180" stroke="#fff" stroke-width="8" opacity=".5"/>',
  candle: '<rect x="140" y="170" width="40" height="120" rx="10" fill="G"/><rect x="220" y="170" width="40" height="120" rx="10" fill="G"/><path d="M160 150c10 10 0 20 0 20s-10-10 0-20zM240 150c10 10 0 20 0 20s-10-10 0-20z" fill="#e9a23b"/>',
};

function shapeFor(handle: string): string {
  if (/mug|espresso/.test(handle)) return 'mug';
  if (/bowl/.test(handle)) return 'bowl';
  if (/plate|platter/.test(handle)) return 'plate';
  if (/vase/.test(handle)) return 'vase';
  if (/jug/.test(handle)) return 'jug';
  if (/planter/.test(handle)) return 'pot';
  if (/dish/.test(handle)) return 'dish';
  if (/candle/.test(handle)) return 'candle';
  if (/card/.test(handle)) return 'card';
  return 'bowl';
}

export function demoArt(handle: string): string {
  const h = hash(handle);
  const glaze = GLAZES[h % GLAZES.length];
  const bg = ['#f3ece3', '#ece7df', '#efe9e1', '#e8ece6'][h % 4];
  const shape = SHAPES[shapeFor(handle)].replace(/G/g, glaze);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${bg}"/><ellipse cx="200" cy="318" rx="130" ry="16" fill="#000" opacity=".08"/>${shape}</svg>`;
}
