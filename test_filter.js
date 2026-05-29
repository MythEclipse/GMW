function filterHits(text, hits) {
  const lowerText = text.toLowerCase();
  return hits.filter(hit => {
    if (hit === "asu") {
      const words = lowerText.match(/[\p{L}\p{N}_]+/gu) || [];
      return words.some(w => 
        w.includes("asu") && 
        !["asus", "masuk", "termasuk", "dimasukkan", "memasukkan", "kasur", "asumsi", "asuransi", "asupan", "pasukan", "pasundan"].includes(w)
      );
    }
    return true;
  });
}

console.log(filterHits("Gua aja mau membeli asus", ["asu"])); // []
console.log(filterHits("asus asu", ["asu"])); // ["asu"]
console.log(filterHits("masuk", ["asu"])); // []
console.log(filterHits("asuuu", ["asu"])); // ["asu"]
console.log(filterHits("ngasu", ["asu"])); // ["asu"]
