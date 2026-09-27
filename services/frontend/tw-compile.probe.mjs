import postcss from "postcss";
import tw from "@tailwindcss/postcss";
import fs from "node:fs";

const root = "/home/code/GMW/services/frontend";
const css = fs.readFileSync(`${root}/src/app/globals.css`, "utf8");

const res = await postcss([tw({ base: `${root}/src/app/globals.css` })])
  .process(css, { from: `${root}/src/app/globals.css`, to: "/tmp/out.css" });
fs.writeFileSync("/tmp/fresh.css", res.css);
console.log("wrote /tmp/fresh.css bytes=", res.css.length);
