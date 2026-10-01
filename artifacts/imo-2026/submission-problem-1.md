# IMO 2026 — Problem 1

## Problem

There are 2026 integers greater than 1 written on a blackboard, not necessarily different. In a
move, Confucius chooses two integers $m>1$ and $n>1$ from different places on the blackboard and
replaces these two integers with

$$\gcd(m,n)\qquad\text{and}\qquad \frac{\operatorname{lcm}(m,n)}{\gcd(m,n)}.$$

He continues to make moves while it is possible to do so.

(a) Prove that, regardless of the choices of Confucius, after finitely many moves, exactly one
integer $M$ on the blackboard is greater than 1.

(b) Prove that the value of $M$ does not depend on the choices of Confucius.

(Note that $\gcd(x,y)$ denotes the greatest common divisor of positive integers $x$ and $y$, and
$\operatorname{lcm}(x,y)$ denotes the least common multiple of $x$ and $y$.)

## Solution

### Notation, terminology, and reading of the rules

Write $N=2026$ for the number of entries on the blackboard. A *board* is a multiset of $N$ positive
integers; its members are called *entries*, and the $N$ entries are thought of as occupying $N$
distinct places. For a positive integer $x$, let $\Omega(x)$ denote the number of prime factors of
$x$ counted with multiplicity, so that $\Omega(1)=0$, and for a prime $p$ let $v_p(x)$ denote the
exponent of $p$ in $x$.

The rule "he continues to make moves while it is possible to do so" is read literally: a move is
available precisely when at least two entries exceed $1$, and the process stops at the first state
in which at most one entry exceeds $1$. Note also that the two entries are chosen "from different
places on the blackboard", so their values may coincide: a move is legal for any two entries
$m,n>1$, including the case $m=n$.

For a move performed on two entries $m,n>1$ we set

$$g:=\gcd(m,n),\qquad \ell:=\frac{\operatorname{lcm}(m,n)}{\gcd(m,n)},$$

so that the move replaces the pair $(m,n)$ by the pair $(g,\ell)$. Both new entries are positive
integers.

### Elementary facts about a single move

**Lemma 1 (per-prime effect of a move).** Let $p$ be a prime, and put $a=v_p(m)$ and $b=v_p(n)$.
Then

$$v_p(g)=\min(a,b),\qquad v_p(\ell)=|a-b|.$$

*Proof.* The number $\operatorname{lcm}(m,n)$ has $p$-exponent $\max(a,b)$. Hence
$v_p\bigl(\operatorname{lcm}(m,n)/\gcd(m,n)\bigr)=\max(a,b)-\min(a,b)=|a-b|$, while
$v_p(g)=v_p(\gcd(m,n))=\min(a,b)$. $\square$

**Lemma 2.** For all integers $a,b\ge 0$ we have $\min(a,b)+|a-b|=\max(a,b)$.

*Proof.* If $a\ge b$, the left-hand side equals $b+(a-b)=a=\max(a,b)$; the case $b\ge a$ is
symmetrical. $\square$

**Lemma 3 (bookkeeping for a move).** In a move the pair $(m,n)$ is replaced by the pair
$(g,\ell)$, and the following hold.

1. $\max(g,\ell)>1$, that is, at least one of $g,\ell$ exceeds $1$; moreover
   $g>1\iff\gcd(m,n)>1$, and $\ell=1\iff m=n$.
2. For every prime $p$,
   $$v_p(g)+v_p(\ell)=\max\bigl(v_p(m),v_p(n)\bigr)\;\le\;v_p(m)+v_p(n),$$
   and the inequality is strict if and only if $\min\bigl(v_p(m),v_p(n)\bigr)>0$.
3. $g\ell=\operatorname{lcm}(m,n)$, hence $mn=g\cdot(g\ell)=g^{2}\ell$.

*Proof.* (1) The statement $g>1\iff\gcd(m,n)>1$ is immediate from $g=\gcd(m,n)$. If $\ell=1$ then
$\operatorname{lcm}(m,n)=\gcd(m,n)$; since $\gcd(m,n)$ divides $m$, and $m$ divides
$\operatorname{lcm}(m,n)=\gcd(m,n)$, we get $m=\gcd(m,n)$, and symmetrically $n=\gcd(m,n)$, so
$m=n$. Conversely, if $m=n$ then $\ell=m/m=1$. Finally, if $g=1$ then $\ell=\operatorname{lcm}(m,n)=mn>1$,
because $m,n>1$ are coprime; and if $g>1$ then $g>1$. Hence $\max(g,\ell)>1$ in every case.

(2) This is Lemma 1 combined with Lemma 2, applied to $a=v_p(m)$ and $b=v_p(n)$.

(3) By definition of $g$ and $\ell$,
$g\ell=\gcd(m,n)\cdot\operatorname{lcm}(m,n)/\gcd(m,n)=\operatorname{lcm}(m,n)$, and the identity
$mn=\gcd(m,n)\cdot\operatorname{lcm}(m,n)$ gives $mn=g\cdot(g\ell)=g^{2}\ell$. $\square$

### Part (a): the process stops with exactly one entry exceeding $1$

Throughout this part, let

$$t:=\#\{\text{entries exceeding } 1\},\qquad
\Omega_{\mathrm{tot}}:=\sum_{x\ \text{entry}}\Omega(x).$$

**Step 1: how $t$ changes in a move.** By Lemma 3(1), both new entries $g,\ell$ are positive and at
least one of them exceeds $1$. So among the two places that were replaced, the number of entries
exceeding $1$ equals $1$ or $2$ after the move (it was $2$ before), and therefore every move
satisfies

$$t\ \longmapsto\ t\quad\text{or}\quad t-1;$$

in particular $t$ never increases. More precisely, there are three mutually exclusive cases.

* *$\gcd(m,n)=1$.* Then $g=1$ and $\ell=\operatorname{lcm}(m,n)=mn>1$, so the pair $(m,n)$ becomes
  $(1,mn)$, and $t$ decreases by exactly $1$.
* *$\gcd(m,n)>1$ and $m=n$.* Then $g=m>1$ and $\ell=\operatorname{lcm}(m,m)/m=m/m=1$, so the pair
  becomes $(m,1)$, and again $t$ decreases by exactly $1$.
* *$\gcd(m,n)>1$ and $m\ne n$.* Then $g>1$, and $\ell>1$ because
  $\operatorname{lcm}(m,n)>\gcd(m,n)$ whenever $m\ne n$ (indeed $\gcd(m,n)$ divides $m$, which
  divides $\operatorname{lcm}(m,n)$, so equality would force $m=\gcd(m,n)=n$). Both new entries
  exceed $1$, and $t$ is unchanged.

**Step 2: how $\Omega_{\mathrm{tot}}$ changes in a move.** Fix a prime $p$ and put $a=v_p(m)$,
$b=v_p(n)$. Before the move, the two chosen entries contribute $a+b=\max(a,b)+\min(a,b)$ to
$\Omega_{\mathrm{tot}}$ at the prime $p$; after the move, by Lemma 1, they contribute
$\min(a,b)+|a-b|=\max(a,b)$. By Lemma 3(2), the number of prime factors (with multiplicity)
contained in the two chosen entries therefore drops by exactly

$$\bigl(v_p(m)+v_p(n)\bigr)-\bigl(v_p(g)+v_p(\ell)\bigr)=\min(a,b)=v_p\bigl(\gcd(m,n)\bigr)$$

at the prime $p$. Only finitely many primes divide $mn$, and no other prime is affected. Summing
over all primes gives

$$\Delta\Omega_{\mathrm{tot}}=-\,\Omega\bigl(\gcd(m,n)\bigr)\;\le\;0,$$

with $\Delta\Omega_{\mathrm{tot}}<0$ precisely when $\gcd(m,n)>1$. In particular
$\Omega_{\mathrm{tot}}$ never increases, and it strictly decreases in the second and the third case
of Step 1.

**Step 3: a strictly decreasing non-negative integer potential.** Define

$$\Phi:=(N+1)\cdot\Omega_{\mathrm{tot}}+t .$$

Since $\Omega_{\mathrm{tot}}$ and $t$ are non-negative integers, so is $\Phi$. We compute the
change $\Delta\Phi$ of $\Phi$ in a move.

* If $\gcd(m,n)=1$: by Step 2, $\Omega_{\mathrm{tot}}$ is unchanged, and by Step 1, $t$ decreases
  by $1$. Hence $\Delta\Phi=-1$.
* If $\gcd(m,n)>1$: by Step 2, $\Omega_{\mathrm{tot}}$ decreases by $\Omega(\gcd(m,n))\ge 1$, and
  by Step 1, $t$ either stays the same or decreases. Hence
  $\Delta\Phi\le-(N+1)\cdot 1+0=-(N+1)<0$.

So every move strictly decreases the non-negative integer $\Phi$. Consequently there cannot be
infinitely many moves: after $k$ moves we would have $\Phi\le\Phi_0-k$, which would be negative for
$k>\Phi_0$, where $\Phi_0$ denotes the initial value of $\Phi$. Hence **only finitely many moves are
possible**; the process halts after at most $\Phi_0$ moves.

**Step 4: at the halt exactly one entry exceeds $1$.** The process halts exactly when no move is
available; by our reading of the rules a move is available exactly when two entries exceed $1$, so
the process halts exactly when $t\le 1$. Initially $t=N=2026\ge 2$. Each move changes $t$ by $0$ or $-1$, so $t$ can only
decrease, and it decreases by at most one per move. Moreover $t\ge 1$ is preserved: a move requires
two entries exceeding $1$, so it can never be performed when $t\le 1$, and in particular $t$ never
drops from $1$ to $0$. Since the process halts by Step 3, it halts at a state with $t\le 1$, and at
that state $t\ge 1$; therefore $t=1$.

**Conclusion of (a).** Regardless of the choices of Confucius, the process terminates after
finitely many moves, and at the terminal state exactly one entry exceeds $1$; write $M>1$ for it
and note that the other $N-1$ entries all equal $1$. $\blacksquare$

### Part (b): the terminal value is independent of the choices

**Step 5: the invariant.** For each prime $p$ define

$$\gamma_p:=\gcd\bigl\{\,v_p(x)\;:\;x\ \text{an entry of the initial board}\,\bigr\},$$

the greatest common divisor of the $N$ non-negative integers $v_p(x)$. This is well defined, with
the convention $\gcd(0,0)=0$; and $\gamma_p=0$ for every prime $p$ that divides none of the initial
entries, so $\gamma_p>0$ for only finitely many primes $p$.

**Lemma 4 (invariance).** For every prime $p$, the quantity

$$\gcd\bigl\{\,v_p(x)\;:\;x\ \text{an entry of the current board}\,\bigr\}$$

is unchanged by every move. Consequently it equals $\gamma_p$ at every stage of the process.

*Proof.* Fix a prime $p$ and a move performed on the entries $m,n$; put $a=v_p(m)$,
$b=v_p(n)$, and let $c_1,\dots,c_{N-2}$ be the $p$-exponents of the other $N-2$ entries. Before the
move the value in question is

$$\gamma=\gcd(a,b,c_1,\dots,c_{N-2}),$$

and by Lemma 1 the multiset of $p$-exponents after the move is
$\{\min(a,b),\,|a-b|,\,c_1,\dots,c_{N-2}\}$, so the new value is

$$\gamma'=\gcd\bigl(\min(a,b),\,|a-b|,\,c_1,\dots,c_{N-2}\bigr).$$

We claim that

$$\gcd\bigl(\min(a,b),\,|a-b|\bigr)=\gcd(a,b).$$

To see this, note first that $\min(a,b)$ and $|a-b|$ are non-negative integer combinations of $a$
and $b$: if $a\le b$ then $\min(a,b)=a$ and $|a-b|=b-a$, while if $b\le a$ then $\min(a,b)=b$ and
$|a-b|=a-b$. Hence $\gcd(a,b)$ divides both $\min(a,b)$ and $|a-b|$, and therefore $\gcd(a,b)$
divides $\gcd(\min(a,b),|a-b|)$. Conversely, let $d=\gcd(\min(a,b),|a-b|)$. Then $d$ divides
$\min(a,b)$ and $|a-b|$, hence $d$ divides their sum
$\min(a,b)+|a-b|=\max(a,b)$ by Lemma 2, hence $d$ divides both $\min(a,b)$ and $\max(a,b)$, and
therefore $d$ divides $\gcd(\min(a,b),\max(a,b))=\gcd(a,b)$. Since each of the two non-negative
integers $\gcd(\min(a,b),|a-b|)$ and $\gcd(a,b)$ divides the other, they are equal, as claimed.

Substituting this identity into the expression for $\gamma'$ and using the associativity of the gcd
of a finite list of non-negative integers,

$$\gamma'=\gcd\bigl(\gcd(a,b),\,c_1,\dots,c_{N-2}\bigr)=\gcd(a,b,c_1,\dots,c_{N-2})=\gamma .$$

So the gcd of the $p$-exponents is unchanged by the move. Starting from the initial board and
applying this to each successive move, the value stays equal to $\gamma_p$ throughout. $\square$

**Step 6: reading off the terminal value.** By Part (a), at the end of the process the board is
$\{M,1,\dots,1\}$ with $M>1$ and with $N-1$ entries equal to $1$. Fix a prime $p$. At that terminal
state the multiset of $p$-exponents of the entries is $\{v_p(M),\,\underbrace{0,\dots,0}_{N-1}\}$,
whose gcd is

$$\gcd\bigl(v_p(M),0,\dots,0\bigr)=v_p(M).$$

By Lemma 4 this number equals $\gamma_p$. Hence

$$v_p(M)=\gamma_p=\gcd\bigl\{\,v_p(x)\;:\;x\ \text{an entry of the initial board}\,\bigr\}
\qquad\text{for every prime } p.$$

Two positive integers with the same $p$-adic valuation for every prime $p$ are equal, so

$$\boxed{\;M\;=\;\prod_{p\,:\,\gamma_p>0}p^{\,\gamma_p}
\;=\;\prod_{p}p^{\,\gcd\{v_p(x)\,:\,x\ \text{initially on the board}\}}\;}$$

where the product is finite because $\gamma_p=0$ for all but finitely many primes $p$.

**Conclusion of (b).** The right-hand side depends only on the initial multiset of $N$ integers and
not on the moves performed, so the terminal value $M$ is the same for every sequence of choices of
Confucius. $\blacksquare$

Finally, $M>1$ is automatic from the formula: some initial entry exceeds $1$, so for some prime $p$
the corresponding term $v_p(x)$ is at least $1$, while all the exponents $v_p(y)$ are non-negative;
hence $\gamma_p$, the gcd of a list of non-negative integers one of which is positive, satisfies
$\gamma_p\ge 1$, and therefore $M=\prod_p p^{\gamma_p}>1$.

As an illustration of the formula, take the two-entry board $\{4,12\}$ (so $N=2$ in this example).
Here the pair of $2$-adic valuations of the two entries is $(v_2(4),v_2(12))=(2,2)$, and the pair of
$3$-adic valuations is $(v_3(4),v_3(12))=(0,1)$; thus $\gamma_2=2$ and $\gamma_3=1$, and the formula
predicts $M=2^{2}\cdot 3=12$. Indeed, one move replaces $(4,12)$ by
$(\gcd(4,12),\ \operatorname{lcm}(4,12)/\gcd(4,12))=(4,3)$, and the next move replaces $(4,3)$ by
$(\gcd(4,3),\operatorname{lcm}(4,3)/\gcd(4,3))=(1,12)$, leaving the entry $12$.
