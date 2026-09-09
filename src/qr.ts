import { renderSVG } from "uqr";

export function qrToSvg(text: string): string {
  return renderSVG(text, {
    border: 2,
    ecc: "M",
    pixelSize: 8,
    whiteColor: "#ffffff",
    blackColor: "#111111",
  });
}
