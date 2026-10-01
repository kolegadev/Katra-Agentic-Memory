# IMO 2026 — submission for external review

This submission consists of six documents, `submission-problem-1.md` … `submission-problem-6.md`, one for
each of the six problems. Each document contains the statement of its problem followed by a complete,
self-contained proof. The six documents are written to be read independently of one another and of any
other material.

A PDF rendering of each document is provided alongside the Markdown: `submission-problem-1.pdf` … `submission-problem-6.pdf` (and `submission-README.pdf`). The PDFs are generated from the Markdown sources, which remain the authoritative versions.

## Answers

| Problem | Answer | File |
|---|---|---|
| 1 | (a) After finitely many moves exactly one entry exceeds $1$, regardless of the choices. (b) That value is independent of the choices: it equals $\prod_p p^{\gamma_p}$, where $\gamma_p=\gcd\{\,v_p(x)\ :\ x\ \text{an entry}\,\}$ is the gcd over the entries $x$ of their $p$-adic valuations $v_p$. | `submission-problem-1.md` |
| 2 | $OM=ON$. | `submission-problem-2.md` |
| 3 | $c_n=\dfrac{2^n}{2^{n+1}-1}$ for every $n$. | `submission-problem-3.md` |
| 4 | Mulan can force a win in finitely many steps exactly for $\theta=\dfrac{180^\circ}{n}$, where $n$ is an integer $\ge 2$. | `submission-problem-4.md` |
| 5 | $f(x)=x+c$ for every $x>0$, where $c\ge 0$ is a constant. | `submission-problem-5.md` |
| 6 | The sequence is eventually periodic: indeed $a_{n+T}=a_n+L$ for all $n\ge 1$, with explicit $L$ and $T$. | `submission-problem-6.md` |

## Notes for the reviewer

1. **Provenance.** The proofs were derived from the problem statements alone; no published, official or
   unofficial solution was consulted at any point.
2. **Self-containedness.** The documents are self-contained: every lemma used is proved in place.
3. **Corrections.** Fixes applied during internal verification have been folded into the text, so no
   errata are expected. The proofs have been independently re-checked internally. The author nonetheless
   welcomes a report of any step that does not check out.
4. **Notation and tools.** The arguments use only elementary tools — induction, parity and pigeonhole
   arguments, elementary algebra and angle-chasing — and no named theorem from outside the standard
   olympiad repertoire. Notation is introduced where it first occurs.
