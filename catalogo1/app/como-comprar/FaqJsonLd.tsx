import JsonLdScript from "@/lib/seo/JsonLdScript";
import { faqJsonLd } from "@/lib/seo/json-ld";
import { FAQ_ITEMS } from "@/lib/constants/faq";

export default function FaqJsonLd() {
  const data = faqJsonLd(
    FAQ_ITEMS.map((item) => ({ question: item.q, answer: item.a }))
  );
  return <JsonLdScript data={data} />;
}
