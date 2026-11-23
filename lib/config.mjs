// Agent branding and contact: every draft and sender header reads from here.
// Keep the numbers identical to ai-ulu.com (src/site/config.mjs) so the agent
// quotes the same promises the site makes.
export const site = {
  name: "ai-ulu",
  owner: "Ali Ulu",
  url: "https://ai-ulu.com",
  email: "aliulu@ai-ulu.com",
  lang: "tr",
  whatsapp: "https://wa.me/905079581642",
  serviceAreas: ["İstanbul", "Ankara", "İzmir", "Bursa"],
  priceFrom: "5.000 ₺'den",
};

// wa.me with a prefilled message. Every WhatsApp link in a draft goes through
// this, so the number and the opening line live in one place.
export function waLink(text) {
  return text ? `${site.whatsapp}?text=${encodeURIComponent(text)}` : site.whatsapp;
}
