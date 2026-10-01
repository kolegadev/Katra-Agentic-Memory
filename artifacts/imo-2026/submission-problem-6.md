# IMO 2026 — Problem 6

**Problem.** Let $a_1,a_2,a_3,\dots$ be an infinite sequence of positive integers greater than $1$.
Suppose that for all positive integers $n$, the number $a_{n+1}$ is the smallest positive integer
greater than $a_n$ such that $\gcd(a_{n+1},a_i)>1$ for every $i=1,2,\dots,n$. Prove that there exist
positive integers $T$ and $L$ such that
$$a_{n+T}=a_n+L$$
for every positive integer $n$. (Note that $\gcd(x,y)$ denotes the greatest common divisor of
positive integers $x$ and $y$.)

## Solution

**Strategy.** The greedy rule is first reformulated as a *blocking condition* **(C0)**: every integer
$m\ge a_1$ that is not a term is coprime to some smaller term (Fact 1). It follows that the term set
is exactly the part $\ge a_1$ of a union of arithmetic progressions, indexed by the
inclusion-minimal prime sets occurring among the terms (Fact 2). The heart of the proof is that
there are only **finitely many** of these minimal prime sets. If there were infinitely many, a
pigeonhole on the finitely many possible "small holes" (Section 6) would manufacture a *nonempty
co-singleton transversal* — a set $M\setminus\{r\}$ meeting every minimal prime set — which Lemma A
forbids; the pigeonhole relies on the small-hole descent of Lemma B and its Corollary 5.1
(Section 5). Once only finitely many progressions remain, their union is periodic with period
$L=\operatorname{lcm}\{\operatorname{rad}(M)\}$, and periodicity shifts the increasing enumeration
of the term set by exactly $T$ places, giving $a_{n+T}=a_n+L$ for every $n\ge1$ (Corollary,
Section 6).

### 1. Terms, prime sets, members: notation and elementary structure

Throughout, let
$$V:=\{a_1,a_2,a_3,\dots\}$$
be the set of **terms** of the sequence. Since $a_{n+1}>a_n$ by hypothesis, the terms are pairwise
distinct and strictly increasing in $n$; in particular $a_n\ge a_1+(n-1)$ for every $n\ge1$, so $V$
is infinite and unbounded above, and $a_n$ is the $n$-th smallest element of $V$. Also $a_1>1$, so
every term is $\ge2$.

For a positive integer $m$, let $P(m)$ be the set of prime divisors of $m$; thus $P(1)=\varnothing$,
$P(m)\ne\varnothing$ for every $m\ge2$, and $P(m)$ is finite for every $m\ge1$. For a finite set $S$
of primes put
$$\operatorname{rad}(S):=\prod_{p\in S}p,\qquad\text{with }\operatorname{rad}(\varnothing):=1,$$
and for $m\ge2$ put $\operatorname{rad}(m):=\operatorname{rad}(P(m))$; the prime divisors of
$\operatorname{rad}(m)$ are exactly those of $m$. For a set $M$ of primes and an integer $m\ge1$ one
has $\operatorname{rad}(M)\mid m$ if and only if $M\subseteq P(m)$.

Put
$$\mathbf F:=\{P(a_n):n\ge1\},\qquad
\min\mathbf F:=\{\text{the inclusion-minimal elements of }\mathbf F\},$$
and call the elements of $\min\mathbf F$ the **members**. A member $M$ is **realized** by a term
$a_j$ if $P(a_j)=M$. Say that a set $X$ **meets** a family $\mathcal G$ of sets if $X\cap G\ne\varnothing$
for every $G\in\mathcal G$ (a *transversal* of $\mathcal G$ is a set meeting $\mathcal G$); a
**co-singleton** of a member $M$ is a set of the form $M\setminus\{r\}$ with $r\in M$.

**Descent principle.** *If $A\in\mathbf F$, then some member $M\in\min\mathbf F$ satisfies
$M\subseteq A$.* Indeed, if $A$ is not minimal in $\mathbf F$, there is $A_1\in\mathbf F$ with
$A_1\subsetneq A$; if $A_1$ is not minimal either, there is $A_2\in\mathbf F$ with
$A_2\subsetneq A_1$; and so on. The sets in this chain decrease strictly inside the *finite* set $A$,
so the process cannot go on for ever: after finitely many steps we reach an element of $\mathbf F$
contained in $A$ that has no element of $\mathbf F$ strictly inside it, i.e. a member contained in
$A$. ∎

Taking $A=P(t)$: **every term $t$ has a prime set containing a member**, i.e. there is
$M\in\min\mathbf F$ with $M\subseteq P(t)$. Taking $A=P(a_1)$, and noting $P(a_1)\in\mathbf F$:
$\min\mathbf F\ne\varnothing$. Let us record also that members are nonempty (they are prime sets of
terms $\ge2$) and finite, so $\mathbf F$ is a nonempty family of nonempty finite sets of primes.

**Fact 0 (elementary structure).**

(a) Any two distinct terms share a prime: $\gcd(t,t')>1$ for all $t,t'\in V$ with $t\ne t'$.

(b) Members pairwise intersect: $M\cap M'\ne\varnothing$ for all $M,M'\in\min\mathbf F$.

(c) Every member meets $P(a_1)$: $M\cap P(a_1)\ne\varnothing$ for every $M\in\min\mathbf F$.

*Proof.* (a) Write $t=a_i$, $t'=a_j$ with $i<j$. Then $i\le j-1$, and the defining condition of the
sequence at step $j-1$ says $\gcd(a_j,a_k)>1$ for every $k\le j-1$; taking $k=i$ gives
$\gcd(a_j,a_i)>1$.

(b) Let $M,M'\in\min\mathbf F$, realized by terms $a_i$, $a_j$ (a member is, by definition, the prime
set of at least one term). If $i=j$, then $M=M'$ and $M\ne\varnothing$, so $M\cap M'=M\ne\varnothing$.
If $i\ne j$, then by (a) $\varnothing\ne P(a_i)\cap P(a_j)=M\cap M'$.

(c) Let $M\in\min\mathbf F$ be realized by $a_j$. If $j=1$ then $M=P(a_1)$. If $j>1$ then $\gcd(a_j,a_1)>1$
by (a), i.e. $M\cap P(a_1)=P(a_j)\cap P(a_1)\ne\varnothing$. ∎

### 2. Fact 1: the greedy rule is reciprocity, and the blocking condition (C0)

**Fact 1 (reciprocity).** *For every integer $m>a_1$,*
$$m\in V\quad\Longleftrightarrow\quad \gcd(m,t)>1\ \text{ for every term } t\in V \text{ with } t<m.$$

*Proof.* ($\Longrightarrow$) Let $m\in V$. The terms are strictly increasing, so $m=a_j$ for a unique
index $j$, and $m>a_1$ gives $j\ge2$. The defining condition of the sequence at step $j-1$ then says
$\gcd(a_j,a_i)>1$ for every $i\le j-1$; since the terms below $m=a_j$ are exactly
$a_1,\dots,a_{j-1}$, this is the assertion.

($\Longleftarrow$) We prove the contrapositive. Let $m\notin V$ with $m>a_1$, and suppose for
contradiction that $\gcd(m,t)>1$ for every term $t<m$. The terms are unbounded above
($a_n\ge a_1+(n-1)$) and $a_1<m$, so the set of terms $<m$ is nonempty and finite; let $a_j$ be its
largest element. Then $a_1,\dots,a_j$ are exactly the terms $<m$ (they are the terms not exceeding
$a_j$, and every term $<m$ lies among them by maximality of $a_j$), so the assumption gives
$\gcd(m,a_i)>1$ for every $i\le j$, and also $m>a_j$. Hence at step $j$ the integer $m$ is
admissible, i.e. it belongs to the set whose least element is $a_{j+1}$; therefore $a_{j+1}\le m$.
Since $a_{j+1}\in V$ and $m\notin V$, we have $a_{j+1}\ne m$, so $a_{j+1}<m$. But then $a_{j+1}$ is a
term with $a_j<a_{j+1}<m$, contradicting the maximality of $a_j$ among the terms $<m$. Hence some
term $t<m$ satisfies $\gcd(t,m)=1$. ∎

**Consequence (C0) (blocking condition).** *For every integer $m\ge a_1$ with $m\notin V$ there
exists a term $t<m$ with $\gcd(t,m)=1$.*

*Proof.* Let $m\ge a_1$, $m\notin V$. Since $a_1\in V$, we have $m\ne a_1$, hence $m>a_1$; by the
contrapositive just proved (applied to $m$), not every term $t<m$ can satisfy $\gcd(t,m)>1$, so some
such term satisfies $\gcd(t,m)=1$. ∎

Fact 1 is an exact reformulation of the greedy rule. Of its two halves, the ($\Longleftarrow$) half
is what yields (C0), and (C0) is the only place in Sections 3–6 where the *minimality* (least-ness)
of the greedy choice is used; the ($\Longrightarrow$) half is the admissibility condition satisfied
by every term, i.e. Fact 0(a). Nothing else about the sequence is used below.

### 3. Fact 2: the term set as a union of progressions

**Fact 2 (union representation).** *For every integer $m\ge a_1$,*
$$m\in V\quad\Longleftrightarrow\quad
\operatorname{rad}(M)\mid m\ \text{ for some member } M\in\min\mathbf F.$$
*Equivalently,*
$$V=\Big(\bigcup_{M\in\min\mathbf F}\operatorname{rad}(M)\,\mathbb Z\Big)\cap[a_1,\infty).$$

*Proof.* Let $m\ge a_1$.

($\Longrightarrow$) If $m\in V$ then $P(m)\in\mathbf F$, and the descent principle gives a member
$M\in\min\mathbf F$ with $M\subseteq P(m)$, i.e. $\operatorname{rad}(M)\mid m$.

($\Longleftarrow$) Suppose $\operatorname{rad}(M)\mid m$ for some $M\in\min\mathbf F$, so
$M\subseteq P(m)$. If $m=a_1$ then $m\in V$; so assume $m>a_1$. We check the criterion of Fact 1.
Let $t$ be any term with $t<m$. By the descent principle applied to $P(t)\in\mathbf F$ there is a
member $M_t\in\min\mathbf F$ with $M_t\subseteq P(t)$. By Fact 0(b), $M\cap M_t\ne\varnothing$, and
$M\cap M_t\subseteq P(m)\cap P(t)$ because $M\subseteq P(m)$ and $M_t\subseteq P(t)$. Hence
$$\varnothing\ne M\cap M_t\subseteq P(m)\cap P(t),$$
so $\gcd(m,t)>1$. As this holds for every term $t<m$, Fact 1 gives $m\in V$. ∎

The restriction to $m\ge a_1$ in Fact 2 is necessary: the union on the right may contain integers
$<a_1$ that are not terms (for instance, with $a_1=15$ the member $\{2,3\}$ gives
$\operatorname{rad}(\{2,3\})=6<15$), and such integers are never terms because all terms are
$\ge a_1$.

### 4. Lemma A: there is no nonempty co-singleton transversal

**Lemma A.** *Let $M\in\min\mathbf F$, $r\in M$, and put $D:=M\setminus\{r\}$. If $D\ne\varnothing$,
then $D$ does not meet $\min\mathbf F$: there exists $N\in\min\mathbf F$ with $N\cap D=\varnothing$.*

*Proof.* Assume, for contradiction, that
$$D=M\setminus\{r\}\ne\varnothing
\quad\text{and}\quad D\cap N\ne\varnothing\ \text{ for every } N\in\min\mathbf F. \tag{$\ast$}$$

*Step 1: every term has a prime divisor in $D$.* Let $t$ be a term. By the descent principle applied
to $P(t)\in\mathbf F$ there is a member $M_t\in\min\mathbf F$ with $M_t\subseteq P(t)$; by $(\ast)$
there is a prime $p\in M_t\cap D$; then $p\in M_t\subseteq P(t)$ divides $t$, and $p\in D$ as
required.

*Step 2: the explicit witness $m:=\operatorname{rad}(D)^k$ is not a term.* Since $D\ne\varnothing$, we
have $\operatorname{rad}(D)\ge2$, so we may fix an integer $k\ge1$ with
$m:=\operatorname{rad}(D)^k\ge a_1$. Then $P(m)=D$. If $m\in V$, then $P(m)=D\in\mathbf F$, and the
descent principle would give a member $M_0\subseteq D=M\setminus\{r\}$. But $r\in M\setminus D$, so
$D\subsetneq M$; thus $M_0\subseteq D\subsetneq M$ with $M_0,M\in\min\mathbf F$, contradicting the
minimality of $M$ in $\mathbf F$. Hence $m\notin V$.

*Step 3: contradiction with (C0).* By Step 2 and $m\ge a_1$, condition (C0) of Section 2 provides a
term $t<m$ with $\gcd(t,m)=1$. But by Step 1 the term $t$ has a prime divisor $p\in D$, and every
prime of $D$ divides $m=\operatorname{rad}(D)^k$; so $p\mid t$ and $p\mid m$, contradicting
$\gcd(t,m)=1$. ∎

*Remark (equivalent "isolation" form).* Lemma A says exactly: for every member $M$ and every $r\in M$
there is a member $N$ with $N\cap M=\{r\}$. For $M=\{r\}$ take $N=M$. For $M\ne\{r\}$ apply Lemma A
to $D=M\setminus\{r\}\ne\varnothing$ to get $N\in\min\mathbf F$ with $N\cap D=\varnothing$; Fact 0(b)
gives $N\cap M\ne\varnothing$, and $N\cap M\subseteq\{r\}$ because $M=(M\setminus\{r\})\cup\{r\}$;
hence $\varnothing\ne N\cap M\subseteq\{r\}$, i.e. $N\cap M=\{r\}$. (Conversely, the isolation form
immediately implies the assertion of Lemma A: if $N\cap M=\{r\}$ then
$N\cap D\subseteq N\cap M=\{r\}$ and $r\notin D$, so $N\cap D=\varnothing$.) ∎

### 5. Lemma B: a small hole at every member-prime (descent)

**Lemma B (one descent step).** *Let $M\in\min\mathbf F$, $r\in M$, and put
$h:=\operatorname{rad}(M\setminus\{r\})$. If $h\ge a_1$, then there exists $M'\in\min\mathbf F$ with
$r\in M'$ and $\operatorname{rad}(M'\setminus\{r\})<h$.*

*Proof.* Since $h\ge a_1>1$, we have $M\setminus\{r\}\ne\varnothing$ (as $\operatorname{rad}(\varnothing)=1$),
and $P(h)=M\setminus\{r\}$.

(i) $h\notin V$: otherwise $P(h)=M\setminus\{r\}\in\mathbf F$ would, by the descent principle,
contain a member $M_0\subseteq M\setminus\{r\}\subsetneq M$ (proper since $r\in M$ but $r\notin M\setminus\{r\}$),
contradicting the minimality of $M$ in $\mathbf F$.

(ii) Since $h\ge a_1$ and $h\notin V$, condition (C0) of Section 2 gives a term $t<h$ with
$\gcd(t,h)=1$.

(iii) By the descent principle applied to $P(t)\in\mathbf F$, fix $M'\in\min\mathbf F$ with
$M'\subseteq P(t)$. Then $M'\cap(M\setminus\{r\})=\varnothing$: a prime in that intersection would
divide $t$ (as $M'\subseteq P(t)$) and would divide $h$ (as the primes of $h$ are exactly those of
$M\setminus\{r\}$), contradicting $\gcd(t,h)=1$. By Fact 0(b), $M'\cap M\ne\varnothing$, and
$M'\cap M\subseteq\{r\}$ because $M=(M\setminus\{r\})\cup\{r\}$; hence $r\in M'$.

(iv) Finally, $M'\subseteq P(t)$ gives $\operatorname{rad}(M')\mid\operatorname{rad}(t)$, hence
$\operatorname{rad}(M')\le\operatorname{rad}(t)\le t<h$; and since $r\in M'$ and $r\in M$,
$$\operatorname{rad}(M'\setminus\{r\})=\frac{\operatorname{rad}(M')}{r}<\frac{h}{r}
\qquad\text{in }\mathbb Q_{>0},$$
an inequality between positive rationals: the identity $\operatorname{rad}(M'\setminus\{r\})=
\operatorname{rad}(M')/r$ holds exactly because $r$ is a prime of $M'$, so both quantities are positive
rationals and no integrality of $h/r$ is used or claimed (indeed $r\nmid h$ in general). Since $r\ge2$
and $h\ge2$ (indeed $h>1$), we have $h/r\le h/2<h$, hence
$\operatorname{rad}(M'\setminus\{r\})<h$. This is the assertion. ∎

**Corollary 5.1 (descent form: a small hole at every member-prime).** *Let $r$ be a prime occurring
in some member of $\min\mathbf F$, i.e. $r\in\Pi:=\bigcup_{M\in\min\mathbf F}M$. Then there exists a
member $M_r\in\min\mathbf F$ with $r\in M_r$ and $\operatorname{rad}(M_r\setminus\{r\})<a_1$.*

*Proof.* Fix a member $M_0\ni r$ (it exists by the definition of $\Pi$) and define recursively a
sequence of members and numbers by $h_j:=\operatorname{rad}(M_j\setminus\{r\})$: if $h_j<a_1$, stop;
if $h_j\ge a_1$, apply Lemma B to the member $M_j$ (which contains $r$) to obtain a member
$M_{j+1}\ni r$ with $h_{j+1}<h_j$. The $h_j$ are positive integers ($h_j=1$ if $M_j=\{r\}$), and as
long as the process has not stopped they form a strictly decreasing sequence; a strictly decreasing
sequence of positive integers is finite, so the process terminates after finitely many steps, and it
can only terminate with $h_j<a_1$. Put $M_r:=M_j$. ∎

*Remark.* The small hole $D_r:=M_r\setminus\{r\}$ of Corollary 5.1 satisfies
$\operatorname{rad}(D_r)<a_1$, so every prime of $D_r$ divides $\operatorname{rad}(D_r)<a_1$, hence
$$D_r\subseteq\{p:\ p\text{ prime},\ p<a_1\},$$
a **finite** set. This finiteness is what the pigeonhole of Section 6 uses.

### 6. Finiteness of $\min\mathbf F$, and the periodicity

**Theorem.** $\min\mathbf F$ is finite.

*Proof.* Assume, for contradiction, that $\min\mathbf F$ is infinite, and put
$\Pi:=\bigcup_{M\in\min\mathbf F}M$ for the set of primes occurring in members of $\min\mathbf F$.

*Step 1: $\Pi$ is infinite.* Otherwise $\Pi$ is finite, and then every member is a subset of $\Pi$,
so $\min\mathbf F\subseteq2^{\Pi}$ is finite — a contradiction, since every subset of a finite set
has finitely many subsets.

*Step 2: a well-defined small hole for every $r\in\Pi$.* By Corollary 5.1, for every prime
$r\in\Pi$ the set of members $M\ni r$ with $\operatorname{rad}(M\setminus\{r\})<a_1$ is nonempty;
choose among them one for which $\operatorname{rad}(M\setminus\{r\})$ is least (the values are
positive integers, so a least one exists), and call it $M_r$; put $D_r:=M_r\setminus\{r\}$. By the
remark of Section 5,
$$D_r\subseteq P_{<a_1}:=\{p\text{ prime}:\ p<a_1\},$$
a finite set; hence $D_r$ ranges over the finite set $2^{P_{<a_1}}$ of subsets of $P_{<a_1}$.

*Step 3 (pigeonhole).* Since $\Pi$ is infinite (Step 1) and the set of values $D_r$, $r\in\Pi$, is
finite (Step 2), there exists a subset $D^\ast\subseteq P_{<a_1}$ such that
$$R^\ast:=\{r\in\Pi:\ D_r=D^\ast\}$$
is infinite.

*Step 4: $D^\ast\ne\varnothing$.* Suppose $D^\ast=\varnothing$. Then for every $r\in R^\ast$ we have
$M_r=D_r\cup\{r\}=D^\ast\cup\{r\}=\{r\}$, a member. Choose two distinct primes $r,r'\in R^\ast$
(possible, since $R^\ast$ is infinite and its elements are distinct primes). Then the members
$\{r\}$ and $\{r'\}$ are disjoint — indeed $r\ne r'$ — contradicting Fact 0(b).

*Step 5: every member meets $D^\ast$.* Let $N\in\min\mathbf F$. For each $r\in R^\ast$, the members
$N$ and $M_r=D^\ast\cup\{r\}$ satisfy $N\cap M_r\ne\varnothing$ by Fact 0(b), i.e.
$N\cap(D^\ast\cup\{r\})\ne\varnothing$. If $N\cap D^\ast=\varnothing$, it follows that $r\in N$ for
every $r\in R^\ast$. But $N$ is finite and $R^\ast$ is infinite (its elements are distinct primes),
so that is impossible. Hence $N\cap D^\ast\ne\varnothing$.

*Step 6: contradiction with Lemma A.* Fix $r_0\in R^\ast$ (possible, as $R^\ast$ is infinite). Then
$M_{r_0}\in\min\mathbf F$, $r_0\in M_{r_0}$, and
$M_{r_0}\setminus\{r_0\}=D_{r_0}=D^\ast$ is nonempty (Step 4) and meets every member of
$\min\mathbf F$ (Step 5). This is a nonempty co-singleton transversal, contradicting Lemma A.

So $\min\mathbf F$ is not infinite, i.e. $\min\mathbf F$ is finite. ∎

**Corollary (solution of Problem 6).** *Let $\min\mathbf F$ be finite (Theorem), and put*
$$L:=\operatorname{lcm}\{\operatorname{rad}(M):M\in\min\mathbf F\},\qquad
T:=\#\{m\in V:\ a_1\le m<a_1+L\}.$$
*Then $L$ and $T$ are positive integers with $L\ge2$, $T\ge1$, and*
$$a_{n+T}=a_n+L\qquad\text{for every positive integer }n.$$

*Proof.* $\min\mathbf F$ is a nonempty finite family of nonempty sets and each
$\operatorname{rad}(M)\ge2$, so $L\ge2$ is a positive integer; $T$ is a nonnegative integer (a
finite count, since $V\subseteq\mathbb Z$ lies in the finite range $[a_1,a_1+L)$), and $T\ge1$
because $a_1\in V$ and $a_1<a_1+L$. As the terms increase, $a_1,\dots,a_T$ are exactly the terms
$<a_1+L$.

*Claim 1.* For every integer $m\ge a_1$:
$$m\in V\quad\Longleftrightarrow\quad m+L\in V.$$
Indeed, by Fact 2 both sides are equivalent to "$\operatorname{rad}(M)\mid m$ for some
$M\in\min\mathbf F$": for the direction $\Rightarrow$, $\operatorname{rad}(M)\mid m$ and
$\operatorname{rad}(M)\mid L$ (as $\operatorname{rad}(M)$ divides the lcm $L$) give
$\operatorname{rad}(M)\mid m+L$, and $m+L\ge a_1$; for the direction $\Leftarrow$,
$\operatorname{rad}(M)\mid m+L$ together with $\operatorname{rad}(M)\mid L$ gives
$\operatorname{rad}(M)\mid(m+L)-L=m$, and $m\ge a_1$. (In both directions we use that every
$\operatorname{rad}(M)$, $M\in\min\mathbf F$, divides $L$.) ∎(Claim 1)

*Claim 2.* The map $\varphi:m\mapsto m+L$ restricts to a strictly increasing bijection of $V$ onto
$V\cap[a_1+L,\infty)$. Indeed, if $m\in V$ then $m\ge a_1$, so $m+L\ge a_1+L$, and $m+L\in V$ by
Claim 1; conversely, if $y\in V$ and $y\ge a_1+L$, then $m:=y-L\ge a_1$ and $y=m+L\in V$, so Claim 1
applied to $m$ gives $m\in V$. Thus $\varphi(V)=V\cap[a_1+L,\infty)$, and $\varphi$ is strictly
increasing. ∎(Claim 2)

By Section 1, the elements of $V$ in increasing order are $a_1<a_2<a_3<\cdots$, and
$V\cap[a_1+L,\infty)=\{a_{T+1}<a_{T+2}<\cdots\}$ by the definition of $T$. A strictly increasing
bijection between two well-ordered sets maps the $n$-th element to the $n$-th element (induction on
$n$: $\varphi(a_1)=\varphi(\min V)=\min\varphi(V)=a_{T+1}$ for the first step, and
$\varphi(a_{n+1})=\min\varphi(\{a_{n+1},a_{n+2},\dots\})=a_{T+n+1}$ for the induction step). Hence
$$a_n+L=\varphi(a_n)=a_{T+n}\qquad\text{for every }n\ge1.\qquad\qed$$

**Remarks on degenerate cases.**

(a) *Members of size one.* Suppose $\{r\}$ is a member (here $r$ is a prime). Then Fact 0(b) applied
to $\{r\}$ and an arbitrary member $N$ gives $\varnothing\ne\{r\}\cap N$, i.e. $r\in N$; so a
singleton member lies inside every member, and by the same token there is **at most one** singleton
member (two distinct ones would be disjoint, contradicting Fact 0(b)). Correspondingly, the proof
above treats this case cleanly at each place where it could arise: Lemma A excludes $D=\varnothing$
from its hypothesis, and its isolation form handles $M=\{r\}$ by taking $N=M$; in Lemma B the case
$M=\{r\}$ gives $h=\operatorname{rad}(\varnothing)=1<a_1$, so no descent step is required; in
Corollary 5.1 the descent stops immediately ($h=1<a_1$), with $M_r=M$; and in Step 4 of the Theorem,
$D^\ast=\varnothing$ would force $M_r=D_r\cup\{r\}=\{r\}$ for all $r\in R^\ast$ — which is exactly
the impossibility just recorded.

(b) *$a_1$ a prime power (in particular a prime, or an even power of $2$).* Let $a_1=p^e$ with $p$
prime and $e\ge1$. Then $P(a_1)=\{p\}$, so $\{p\}\in\mathbf F$; and Fact 0(c) says that every member
$M$ satisfies $M\cap\{p\}\ne\varnothing$, i.e. $p\in M$. Hence $\{p\}\subseteq M$; but $\{p\}$ is
itself an element of $\mathbf F$ contained in $M$, so the minimality of $M$ in $\mathbf F$ forces
$\{p\}=M$. Thus $\min\mathbf F=\{\{p\}\}$, and Fact 2 gives $V=p\mathbb Z\cap[a_1,\infty)$; the
Corollary then gives $L=p$ and $T=1$, i.e. $a_{n+1}=a_n+p$ for every $n\ge1$.

(c) *$a_1$ even.* No separate argument is needed in general: the proof above uses only $a_1>1$ and
never distinguishes the parity of $a_1$; the special case $a_1=2^e$ is covered by (b), and for
general even $a_1$ nothing degenerates. Likewise nothing in the argument depends on $a_1$ being
squarefree or on the size of $P(a_1)$.
