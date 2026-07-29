export interface CorpusDocument {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export const CORPUS: CorpusDocument[] = [
  {
    id: "policy-approval-thresholds",
    title: "Invoice Approval Thresholds",
    body: "Invoices at or below 5000 USD are auto-approved. Invoices above 5000 USD require manager approval before payment. Invoices above 50000 USD require director approval.",
    tags: ["policy", "approval", "threshold"],
  },
  {
    id: "policy-vendor-onboarding",
    title: "Vendor Onboarding Requirements",
    body: "New vendors must supply a tax identification number and banking details before their first invoice is paid. Vendors flagged as high risk require a compliance review.",
    tags: ["policy", "vendor", "onboarding"],
  },
  {
    id: "policy-payment-terms",
    title: "Standard Payment Terms",
    body: "Default payment terms are net 30 from invoice receipt. Early payment discounts of 2 percent apply when settled within 10 days.",
    tags: ["policy", "payment", "terms"],
  },
  {
    id: "vendor-acme-profile",
    title: "Vendor Profile: Acme Supplies",
    body: "Acme Supplies has been an approved vendor since 2021. Risk rating: low. Standard terms net 30. Contact: accounts@acme.example.",
    tags: ["vendor", "acme", "profile"],
  },
  {
    id: "vendor-globex-profile",
    title: "Vendor Profile: Globex Industrial",
    body: "Globex Industrial was onboarded in 2026 and is currently under enhanced monitoring. Risk rating: high. All invoices require manual review regardless of amount.",
    tags: ["vendor", "globex", "profile", "high-risk"],
  },
];

/** Simple term-overlap scoring. Deterministic, no external service. */
export function searchCorpus(query: string, topK = 3): CorpusDocument[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) return [];

  const scored = CORPUS.map((doc) => {
    const haystack = `${doc.title} ${doc.body} ${doc.tags.join(" ")}`.toLowerCase();
    const score = terms.reduce(
      (acc, term) => acc + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, topK)
    .map((s) => s.doc);
}
