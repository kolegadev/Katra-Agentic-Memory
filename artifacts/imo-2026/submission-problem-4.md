# IMO 2026 — Problem 4

## Problem

Shan-Yu and Mulan are playing a game. Let $\theta$ be an angle with $0^\circ<\theta<180^\circ$ known
to both players. Initially, Shan-Yu makes a paper triangle $T$ with measurements of his choice. Then,
they repeatedly perform the following steps:

* If $T$ has at least one angle measuring exactly $\theta$, then the game stops and Mulan wins.
* Otherwise, Mulan chooses a point $P$ on the perimeter of $T$, different from its three vertices.
  She then makes a straight cut from $P$ to the opposite vertex of $T$, splitting it into two
  triangles.
* Shan-Yu discards one of the two triangles. The remaining triangle becomes the new $T$.

For which real values of $\theta$ can Mulan guarantee her victory in finitely many steps, no matter
how Shan-Yu plays?

## Answer

$$\boxed{\;\text{Mulan wins exactly for }\ \theta=\frac{180^\circ}{n},\quad n\in\{2,3,4,\dots\}.}$$

Equivalently: exactly those $\theta$ for which $180^\circ/\theta$ is an integer $\ge2$. (The problem
has $0^\circ<\theta<180^\circ$, so $n=1$, i.e. $\theta=180^\circ$, cannot occur; and for every integer
$n\ge2$ we have $180^\circ/n\in(0^\circ,90^\circ]\subset(0^\circ,180^\circ)$, so no value of the form
$180^\circ/n$ is excluded by the hypothesis.)

## Solution

### 0. Conventions, notation, and reading of the rules

**(0.1) Angles and triangles.** Angles are measured in degrees. A *triangle* is non-degenerate: its
three angles are strictly between $0^\circ$ and $180^\circ$ and sum to $180^\circ$. We write a
triangle as the triple $(A,B,C)$ of its angles, and we freely relabel its vertices $A,B,C$; the whole
game refers only to angles (the stopping condition and both players' moves are of this kind), and
every statement below is invariant under renaming the vertices, so relabelling is harmless. Nothing
in the solution uses metric information beyond the angles: the cuts used are described by angles
only, and by (0.4) each such angle description corresponds to an actual, physically realisable cut.

**(0.2) How a round is read.** The three bullets form one round, and rounds are repeated. In each
round the *check* of the first bullet is performed first. Consequently:

* if the current triangle has an angle exactly $\theta$, the game has already stopped and Mulan has
  won — no cut is made;
* otherwise Mulan *must* cut (the second bullet prescribes that she chooses a point and cuts), and
  after Shan-Yu's discarding the next round begins with a new check.

Thus "Mulan wins with at most $k$ cuts" means: whatever Shan-Yu does, the check performed after her
$k$-th cut (or at an earlier check) finds a triangle with an angle exactly $\theta$. In particular, if
Shan-Yu's *initial* triangle has an angle $\theta$, then the first check stops the game before Mulan
moves, so Mulan wins with $0$ cuts; this is used in Lemma 2 below.

**(0.3) Legal cuts.** Since $T$ is non-degenerate, a point $P$ of its perimeter other than the three
vertices lies in the relative interior of exactly one side, and the "opposite vertex" is then the
vertex not lying on that side. Hence every legal cut has the following form: choose a vertex (the
*apex* of the cut), choose a point $P$ in the relative interior of the opposite side, and cut along
the segment joining them. Both resulting pieces are non-degenerate triangles (their vertices are not
collinear). We shall always name the apex of the cut $A$ and the other two vertices $B,C$; the side
$BC$ is the one that $P$ lies on.

**(0.4) Parametrising a cut and realising it.** Let $T=(A,B,C)$ be a triangle and let a cut have apex
$A$, with $P$ in the relative interior of $BC$. Put $x=\angle BAP$. Then $0^\circ<x<A$, and
conversely for every $x\in(0^\circ,A)$ there is exactly one such point $P$: as $P$ runs along the side
$BC$ from $B$ to $C$, the angle $\angle BAP$ increases continuously and strictly from $0^\circ$ to
$A$ (indeed, if $P_1$ lies between $B$ and $P_2$ on $BC$, then $P_1$ is an interior point of the
segment $BP_2$, the side opposite $A$ in triangle $ABP_2$, so the ray $AP_1$ lies strictly inside
$\angle BAP_2$ and $\angle BAP_1<\angle BAP_2$; since the direction of $AP$ varies continuously with $P$
and the limiting values at $B$ and at $C$ are $0^\circ$ and $A$, this is the asserted strict
monotonicity). So a cut with apex $A$ is exactly a choice of a real number $x\in(0^\circ,A)$, and "cut with
apex $A$ and parameter $x$" is an unambiguous instruction that a player can carry out physically.

**(0.5) Multiples of $\theta$.** Write $\theta\mathbb Z_{>0}=\{\theta,2\theta,3\theta,\dots\}$. An
angle $\alpha\in(0^\circ,180^\circ)$ lies in $\theta\mathbb Z_{>0}$ exactly when $\alpha=m\theta$ for
some integer $m\ge1$. Note $\theta=1\cdot\theta\in\theta\mathbb Z_{>0}$.

**(0.6) Structure of the solution.** Section 1 computes the two pieces of an arbitrary cut.
Section 2 (Part I) proves that for $\theta=180^\circ/n$, $n\ge2$, Mulan wins from every triangle and
gives her strategy and an explicit bound on the number of cuts (Lemma 2, Propositions 3 and 4,
Corollary 5). Section 3 (Part II) proves that for every other $\theta$ Shan-Yu has a strategy that
prevents the game from ever stopping (Lemmas 6 and 8, Corollary 7, Theorem 9). Section 4 collects
the edge cases and remarks, Section 5 states the conclusion.

### 1. Lemma 1 (the two pieces of one cut)

**Lemma 1.** Let $T=(A,B,C)$ be a triangle, and let Mulan cut with apex $A$ and parameter
$x=\angle BAP\in(0^\circ,A)$, where $P$ lies in the relative interior of $BC$. Then the two pieces
are the triangles
$$T_1=ABP=\bigl(B,\ x,\ 180^\circ-B-x\bigr)=\bigl(B,\ x,\ A+C-x\bigr),\qquad
T_2=ACP=\bigl(C,\ A-x,\ B+x\bigr),$$
where each triple lists the angles of the piece at the three vertices in the order written. In
particular both pieces are non-degenerate.

*Proof.* The segment $AP$ joins the vertex $A$ to a point $P$ of the relative interior of the
opposite side $BC$; it splits $T$ into the two triangles $ABP$ and $ACP$, and each of these has
three non-collinear vertices, hence is non-degenerate. Their angles are computed from
$A+B+C=180^\circ$: in $ABP$,
$$\angle ABP=\angle ABC=B,\qquad \angle BAP=x,\qquad
\angle APB=180^\circ-B-x=A+C-x,$$
and in $ACP$,
$$\angle ACP=\angle ACB=C,\qquad \angle CAP=\angle BAC-\angle BAP=A-x,\qquad
\angle APC=180^\circ-C-(A-x)=B+x,$$
where $\angle CAP=A-x$ because the ray $AP$ lies strictly inside the angle $\angle BAC=\angle A$.
All six displayed quantities are positive: $B>0$, $x>0$ (by (0.4)), $A-x>0$ (by (0.4)), $C>0$,
$A+C-x=(A-x)+C>0$ and $B+x>0$. $\square$

**Remark 1.1.** Lemma 1 shows that the whole game can be followed on angle data: if the current
triangle has angle triple $(A,B,C)$ and Mulan announces an apex and a parameter $x$, then the two
triples available to Shan-Yu are as displayed, and by (0.4) every $x$ in the stated interval is
attainable by an actual cut.

### 2. Part I — Mulan wins when $\theta=180^\circ/n$, $n\ge2$

Throughout this part $\theta=180^\circ/n$ with a fixed integer $n\ge2$; thus $\theta\le90^\circ$ and
$n\theta=180^\circ$.

#### 2.1 Lemma 2 (the $m\theta$-lemma)

**Lemma 2.** Let $m\ge1$ be an integer with $m\theta\le180^\circ$. If the current triangle has an
angle equal to $m\theta$, then Mulan can force a win; more precisely, she can force a win with at
most $m-1$ cuts, by the following rule: *while the current triangle has no angle equal to $\theta$,
cut from the vertex carrying the angle designated below, with parameter $\theta$*, where "designated"
means: first the given angle $m\theta$ itself, and after a cut that keeps a piece containing
$(m-1)\theta$, the angle $(m-1)\theta$ of that piece. The designation — which multiple of $\theta$ is
currently being reduced, and at which vertex it sits — is thus part of Mulan's strategy state: it is
inherited from the history of the play and is not determined by the current triangle alone, as
Remark 2.1 below demonstrates (a rule that re-designates from the current triangle alone need not win).

*Proof.* Induction on $m\ge1$.

* $m=1$: the current triangle has an angle $\theta$, so the check stops the game before Mulan has to
  cut (0.2); she wins with $0$ cuts, and the strategy instruction is vacuous.

* $m\ge2$: write the current triangle as $(m\theta,B,C)$, the angle $m\theta$ sitting at the vertex
  $A$. Since $m\ge2$ we have $0<\theta<m\theta=A$, so by (0.4) the cut with apex $A$ and parameter
  $x=\theta$ is legal. By Lemma 1 its pieces are
  $$T_1=\bigl(B,\ \theta,\ 180^\circ-B-\theta\bigr),\qquad T_2=\bigl(C,\ (m-1)\theta,\ B+\theta\bigr),$$
  and both are non-degenerate by Lemma 1 (here $180^\circ-B-\theta=A+C-\theta=(m-1)\theta+C>0$ and
  $(m-1)\theta\ge\theta>0$).
  Now $T_1$ has an angle exactly $\theta$, while $T_2$ has the angle $(m-1)\theta$, with $m-1\ge1$
  and $(m-1)\theta\le m\theta\le180^\circ$. If Shan-Yu keeps $T_1$, the next check stops the game:
  Mulan has won, using $1$ cut. If Shan-Yu keeps $T_2$, then the induction hypothesis applies to the
  integer $m-1$ and to $T_2$, whose designated angle $(m-1)\theta$ sits at the vertex that was the
  apex of the cut: Mulan wins from $T_2$ with at most $(m-1)-1=m-2$ further cuts. In either case
  Mulan wins, and the number of cuts is at most $1+(m-2)=m-1$.

This completes the induction. $\square$

**Remark 2.1 (the designation is essential).** The rule must cut from the vertex carrying the angle
that the induction designates, i.e. the multiple $m\theta$ with $m\ge2$ that is to be reduced to
$(m-1)\theta$. Cutting with parameter $\theta$ from a vertex whose angle is a *different* multiple of
$\theta$ can be kept cycling by Shan-Yu. Example: $\theta=20^\circ$ and the triangle
$(40^\circ,60^\circ,80^\circ)$, whose angles are $2\theta,3\theta,4\theta$ (so no angle equals
$\theta$). Cutting from the $80^\circ$-vertex with parameter $20^\circ$ gives the pieces
$(40^\circ,20^\circ,120^\circ)$ and $(60^\circ,60^\circ,60^\circ)$; cutting from the $60^\circ$-vertex
with parameter $20^\circ$ gives $(40^\circ,20^\circ,120^\circ)$ and $(80^\circ,40^\circ,60^\circ)$,
i.e. a piece of the original shape. In each case Shan-Yu keeps the piece with no angle $20^\circ$ (the
equilateral one, or the one of shape $(40^\circ,60^\circ,80^\circ)$), and the position repeats, so
such a mis-directed rule need not ever win. The designated cut — from the $40^\circ$-vertex, the
angle $2\theta$ — gives $(60^\circ,20^\circ,100^\circ)$ and $(80^\circ,20^\circ,80^\circ)$, both
containing $\theta=20^\circ$, so that the game ends at the next check. The induction above records
the correct designation.

#### 2.2 Proposition 3 (case $n\ge3$, i.e. $\theta\le60^\circ$)

**Proposition 3.** Let $n\ge3$ and $\theta=180^\circ/n$. Then from *every* triangle, Mulan can force
a win in at most $n-1$ cuts. (The strategy is described inside the proof; it depends only on the
current triangle.)

*Proof.* Fix an arbitrary triangle $T=(A,B,C)$.

*Step 1: some angle of $T$ exceeds $\theta$.* If some angle of $T$ equals $\theta$, the check stops
the game and Mulan has won (with no cuts). So assume no angle of $T$ equals $\theta$. If all three
angles were $\le\theta$, then $180^\circ=A+B+C\le3\theta$, hence $\theta\ge60^\circ$. For
$\theta<60^\circ$ that is impossible; for $\theta=60^\circ$ it forces $A=B=C=60^\circ=\theta$,
contrary to the assumption that no angle equals $\theta$. Therefore in every case some angle of $T$
exceeds $\theta$; relabel the vertices so that this angle is $A$, i.e.
$$A>\theta,\qquad B+C=180^\circ-A.$$

*Step 2: choosing the parameter $j$.* The open interval $\bigl(B/\theta,\,(A+B)/\theta\bigr)$ has
length $A/\theta>1$, and an open interval of length $>1$ contains an integer (if it is
$(a,a+L)$ with $L>1$, then $\lfloor a\rfloor+1\in(a,a+L)$); choose an integer $j$ with
$$\frac{B}{\theta}<j<\frac{A+B}{\theta}.$$
Then $j\theta>B>0$ and $j\theta<A+B<180^\circ=n\theta$. Hence $1\le j\le n-1$, and
$x:=j\theta-B$ satisfies
$$x>0\ \ \text{and}\ \ x<A\iff j\theta<A+B,$$
so $x\in(0^\circ,A)$ and, by (0.4), $x$ is a legal cut parameter at the apex $A$.

*Step 3: the cut.* Mulan cuts with apex $A$ and parameter $x=j\theta-B$. By Lemma 1 the pieces are
$$T_1=\bigl(B,\ x,\ 180^\circ-B-x\bigr)=\bigl(B,\ j\theta-B,\ 180^\circ-j\theta\bigr)
      =\bigl(B,\ j\theta-B,\ (n-j)\theta\bigr),$$
$$T_2=\bigl(C,\ A-x,\ B+x\bigr)=\bigl(C,\ A+B-j\theta,\ j\theta\bigr),$$
using $180^\circ=n\theta$ in the first line; both pieces are non-degenerate by Lemma 1.

*Step 4: each piece is winning for Mulan.* From $1\le j\le n-1$ we get $1\le n-j\le n-1$. So $T_1$
carries the angle $(n-j)\theta$ with $1\cdot\theta\le(n-j)\theta\le(n-1)\theta<180^\circ$, and $T_2$
carries the angle $j\theta$ with $1\le j\le n-1$ and $j\theta\le(n-1)\theta<180^\circ$. Thus each
piece has an angle $m\theta$ for an integer $m\ge1$ with $m\theta\le180^\circ$ (take $m=n-j$ for
$T_1$, $m=j$ for $T_2$), so by Lemma 2 Mulan, playing from that piece, forces a win in at most
$(n-j)-1$, respectively $j-1$, further cuts — in either case at most $n-2$.

Whatever piece Shan-Yu keeps, Mulan therefore wins. Counting the cut of Step 3, the total number of
cuts is at most $1+(n-2)=n-1$. $\square$

#### 2.3 Proposition 4 (case $n=2$, i.e. $\theta=90^\circ$)

**Proposition 4.** Let $\theta=90^\circ$. Then from *every* triangle, Mulan can force a win with at
most one cut.

*Proof.* Fix an arbitrary triangle $T=(A,B,C)$. If some angle equals $90^\circ$, the check stops the
game. Assume no angle is $90^\circ$. Let $A$ be a vertex carrying a largest angle of $T$ (relabel the
vertices accordingly). Then
$$B<90^\circ\quad\text{and}\quad C<90^\circ:$$
indeed, if $A>90^\circ$ then $B+C=180^\circ-A<90^\circ$ so $B,C<90^\circ$; and if $A<90^\circ$ then
all three angles are $<90^\circ$. (These are the only possibilities, since $A=90^\circ$ is excluded.)

Put $x=90^\circ-B$. Then $x>0$, and
$$x<A\iff 90^\circ-B<A\iff 90^\circ<A+B\iff 90^\circ<180^\circ-C\iff C<90^\circ,$$
which holds; hence $x\in(0^\circ,A)$ and, by (0.4), $x$ is a legal parameter at the apex $A$.

Mulan cuts with apex $A$ and parameter $x$. By Lemma 1 the pieces are
$$T_1=\bigl(B,\ x,\ A+C-x\bigr)=\bigl(B,\ 90^\circ-B,\ 90^\circ\bigr),\qquad
T_2=\bigl(C,\ A-x,\ B+x\bigr)=\bigl(C,\ A-90^\circ+B,\ 90^\circ\bigr),$$
because $A+C-x=A+C-(90^\circ-B)=180^\circ-90^\circ=90^\circ$ and $B+x=90^\circ$. Both triples are
non-degenerate: $0<B<90^\circ$, $0<C<90^\circ$ and
$$A-90^\circ+B=(A+B)-90^\circ=(180^\circ-C)-90^\circ=90^\circ-C>0.$$
Both pieces contain a right angle, so whatever Shan-Yu keeps, the next check stops the game: Mulan
has won with one cut. $\square$

#### 2.4 Corollary 5 (Mulan wins in finitely many steps, with an explicit bound)

**Corollary 5.** Let $\theta=180^\circ/n$ with an integer $n\ge2$. Then from every triangle — in
particular from Shan-Yu's initial triangle, whatever it is — Mulan has a strategy that wins in at
most $n-1$ cuts. Hence she wins after finitely many steps, no matter how Shan-Yu plays.

*Proof.* For $n\ge3$ this is Proposition 3; for $n=2$ Proposition 4 gives at most $1=n-1$ cut. In
both cases the strategy is the explicit one described in the proof (Steps 2–3 and Lemma 2 for
$n\ge3$; the cut $x=90^\circ-B$ at a largest-angle vertex for $n=2$), and it works from every initial
triangle, which is exactly what "no matter how Shan-Yu plays" requires (he chooses the initial
triangle and he chooses which piece to keep, and both choices have been covered). $\square$

**Example 5.1 (Mulan's rule carried out numerically).** Take $\theta=45^\circ$ (so $n=4$) and
$T=(100^\circ,50^\circ,30^\circ)$. No angle equals $45^\circ$; the largest angle is $A=100^\circ>45^\circ$,
with $B=50^\circ$, $C=30^\circ$. The interval $\bigl(B/\theta,(A+B)/\theta\bigr)=(1.11\ldots,3.33\ldots)$
contains $j=2$, and $x=j\theta-B=90^\circ-50^\circ=40^\circ\in(0^\circ,100^\circ)$. Mulan cuts with
apex $100^\circ$ and parameter $40^\circ$; by Lemma 1 the pieces are
$$T_1=(50^\circ,40^\circ,90^\circ),\qquad T_2=(30^\circ,60^\circ,90^\circ),$$
both containing $90^\circ=2\theta$, so both are winning by Lemma 2. If Shan-Yu keeps
$T_1=(50^\circ,40^\circ,90^\circ)$, Mulan designates the angle $90^\circ=2\theta$, cuts from its
vertex with parameter $\theta=45^\circ$, and obtains (Lemma 2 with $m=2$)
$$(40^\circ,45^\circ,95^\circ)\quad\text{and}\quad(50^\circ,45^\circ,85^\circ),$$
both containing $45^\circ$; the following check ends the game. So the game ends after at most two
cuts. (If instead Shan-Yu keeps $T_2=(30^\circ,60^\circ,90^\circ)$, Mulan designates its angle
$90^\circ=2\theta$ and cuts from that vertex with parameter $45^\circ$, obtaining
$(60^\circ,45^\circ,75^\circ)$ and $(30^\circ,45^\circ,105^\circ)$, again both containing $45^\circ$.)

### 3. Part II — Shan-Yu survives when $180^\circ/\theta\notin\mathbb Z$

From now on, $\theta\in(0^\circ,180^\circ)$ is *not* of the form $180^\circ/n$ with $n$ an integer.
Equivalently,
$$k\theta\ne180^\circ\qquad\text{for every integer }k, \tag{3.1}$$
because $k\theta=180^\circ$ with $k$ an integer forces $k\ge1$ and $180^\circ/\theta=k\in\mathbb Z$,
and conversely $180^\circ/\theta=k\in\mathbb Z$ gives $k\theta=180^\circ$.

**Definition (the safe set).** Call a triangle *safe* if none of its angles lies in
$\theta\mathbb Z_{>0}$, and let
$$\mathcal S=\bigl\{T:\ T\text{ is safe}\bigr\}=\bigl\{T:\ \text{no angle of }T\text{ equals }
m\theta\text{ for any integer }m\ge1\bigr\}.$$
By (0.5), $\theta\in\theta\mathbb Z_{>0}$; hence every safe triangle has no angle exactly $\theta$.
So if Shan-Yu can keep the current triangle safe after every move, the stopping condition never
fires.

#### 3.1 Lemma 6 (the equilateral triangle is safe)

**Lemma 6.** $60^\circ\notin\theta\mathbb Z_{>0}$. Consequently the equilateral triangle
$(60^\circ,60^\circ,60^\circ)$ is safe.

*Proof.* Suppose $60^\circ=m\theta$ for some integer $m\ge1$. Then $180^\circ=3\cdot60^\circ=3m\theta$,
so $180^\circ/\theta=3m$ is an integer; equivalently $\theta=180^\circ/(3m)$ is of the form
$180^\circ/n$ with $n=3m\ge3$ an integer. This contradicts the hypothesis of Part II. Hence no
positive integer multiple of $\theta$ equals $60^\circ$; as $60^\circ$ is the only angle of the
equilateral triangle, that triangle is safe. $\square$

**Corollary 7 (Shan-Yu's opening move is legal and safe).** Shan-Yu opens by making an equilateral
triangle. The rules let him choose the measurements, so this move is legal; by Lemma 6 the initial
triangle is safe, so it has no angle equal to $\theta$ and the first check does not stop the game.
$\square$

#### 3.2 Lemma 8 (safety is preserved by every legal cut)

**Lemma 8.** Let $T$ be a safe triangle and let Mulan make *any* legal cut of $T$, producing pieces
$T_1,T_2$. Then at least one of $T_1,T_2$ is safe.

*Proof.* Write the angles of $T$ as $(A,B,C)$. By (0.3)–(0.4) a legal cut is described by naming the
apex $A$ and calling the other two vertices $B$ and $C$ (in either order); with this naming the cut
has a parameter $x=\angle BAP\in(0^\circ,A)$, and by Lemma 1 the two pieces are
$$T_1=\bigl(B,\ x,\ A+C-x\bigr),\qquad T_2=\bigl(C,\ A-x,\ B+x\bigr).$$
Since $T$ is safe,
$$A\notin\theta\mathbb Z_{>0},\qquad B\notin\theta\mathbb Z_{>0},\qquad
C\notin\theta\mathbb Z_{>0}. \tag{3.2}$$

*Which angles could be dangerous.* The angles of $T_1$ are $B,x,A+C-x$, and $B\notin\theta\mathbb Z_{>0}$
by (3.2); hence
$$T_1\text{ is unsafe }\iff x\in\theta\mathbb Z_{>0}\ \text{ or }\ A+C-x\in\theta\mathbb Z_{>0}.$$
Likewise the angles of $T_2$ are $C,A-x,B+x$ with $C\notin\theta\mathbb Z_{>0}$ by (3.2); hence
$$T_2\text{ is unsafe }\iff A-x\in\theta\mathbb Z_{>0}\ \text{ or }\ B+x\in\theta\mathbb Z_{>0}.$$
By Lemma 1 all four quantities $x$, $A-x$, $A+C-x$, $B+x$ are $>0$, so each lies in
$\theta\mathbb Z_{>0}$ exactly when it equals $m\theta$ for some integer $m\ge1$.

*Both pieces unsafe would force one of four cases; each is impossible.* Suppose both pieces are
unsafe. Then one of the following holds, for integers $m,p\ge1$:

1. $x=m\theta$ and $A-x=p\theta$. Then $A=x+(A-x)=(m+p)\theta\in\theta\mathbb Z_{>0}$ (as
   $m+p\ge1$), contradicting (3.2).
2. $x=m\theta$ and $B+x=p\theta$. Then $B=(p-m)\theta$. Since $B>0$ and $\theta>0$, we get
   $p-m>0$, hence $p-m\ge1$ and $B=(p-m)\theta\in\theta\mathbb Z_{>0}$, contradicting (3.2).
3. $A+C-x=m\theta$ and $A-x=p\theta$. Subtracting, $C=(m-p)\theta$. Since $C>0$ and $\theta>0$, we
   get $m-p>0$, hence $C=(m-p)\theta\in\theta\mathbb Z_{>0}$, contradicting (3.2).
4. $A+C-x=m\theta$ and $B+x=p\theta$. Adding, and using $A+B+C=180^\circ$,
   $$180^\circ=A+B+C=(A+C-x)+(B+x)=(m+p)\theta,$$
   so $180^\circ/\theta=m+p\in\mathbb Z$, contradicting (3.1).

All four cases are impossible, so "both pieces unsafe" is impossible: $T_1$ or $T_2$ is safe. The
cut was arbitrary, and the naming of the vertices in the first line of the proof is merely a
relabelling, so the conclusion holds for every legal cut of $T$. $\square$

**Remark 8.1 (why case 4 is exactly the winning case for Mulan).** Case 4 is the only one that uses
(3.1). If $\theta=180^\circ/n$ then $180^\circ=n\theta$, so case 4 is satisfiable (take
$m+p=n$), and indeed Part I exhibits cuts for which both pieces carry a multiple of $\theta$; when
$180^\circ/\theta\notin\mathbb Z$ no such pair $m,p$ exists, and Shan-Yu keeps a safe piece.

#### 3.3 Theorem 9 (Shan-Yu's strategy)

**Theorem 9.** Assume $180^\circ/\theta\notin\mathbb Z$, i.e. (3.1). Then Shan-Yu has a strategy such
that, for every sequence of choices made by Mulan, no current triangle ever has an angle exactly
$\theta$; the game therefore never stops. In particular Mulan cannot guarantee her victory in
finitely many steps.

*Proof (the strategy).* Shan-Yu proceeds as follows.

* *Opening move.* He makes an equilateral triangle. By Corollary 7 this is legal, does not trigger
  the first check, and the triangle is safe.
* *Response to a cut.* Suppose the current triangle $T$ is safe and Mulan has made a legal cut of
  $T$ into pieces $T_1,T_2$. (She must cut, since the check did not fire.) By Lemma 8 at least one
  of $T_1,T_2$ is safe; Shan-Yu keeps a safe piece (if both are safe he keeps either one) and
  discards the other. The new current triangle is then safe as well.

By induction over the rounds, at the beginning of every round the current triangle is safe. A safe
triangle has no angle in $\theta\mathbb Z_{>0}$, and $\theta\in\theta\mathbb Z_{>0}$; hence no
current triangle ever has an angle equal to $\theta$. Therefore the first bullet of the rules never
applies: the game never stops and Mulan never wins. Since Lemma 8 covers *every* legal cut and
Shan-Yu's response covers *every* choice of the piece he keeps, this holds against every possible
play of Mulan; so Mulan cannot guarantee a win. $\square$

**Remark 9.1 (Shan-Yu's family of triangles).** The family $\mathcal S$ is non-empty (it contains
the equilateral triangle, Lemma 6), closed under "keep one of the two pieces" (Lemma 8), and contains
no triangle having an angle exactly $\theta$. Shan-Yu's entire strategy is: open with the equilateral
triangle and thereafter stay inside $\mathcal S$. The concrete family is thus the union of all
triangles reachable from the equilateral one by repeatedly keeping a safe piece.

**Remark 9.2 (the answer is exactly the complement).** Part I (Corollary 5) shows Mulan wins for
$180^\circ/\theta\in\mathbb Z$, $n\ge2$; Theorem 9 shows Shan-Yu survives for
$180^\circ/\theta\notin\mathbb Z$. These two cases exhaust all $\theta\in(0^\circ,180^\circ)$.

### 4. Edge cases, boundary behaviour, and remarks

**(a) $\theta=60^\circ$ ($n=3$).** Proposition 3 covers it, and the only place where the value $60^\circ$
is delicate is Step 1: the sub-case "all three angles $\le\theta$" is not immediately contradictory
but forces the equilateral triangle, in which an angle equals $\theta$ and the game has already
stopped. So the conclusion "some angle strictly exceeds $\theta$" is valid for $\theta=60^\circ$ too.
For instance with $T=(100^\circ,50^\circ,30^\circ)$ and $\theta=60^\circ$ one may take $B=50^\circ$,
$j=1$, $x=10^\circ$; the pieces are $(50^\circ,10^\circ,120^\circ)$ and $(30^\circ,90^\circ,60^\circ)$,
the second of which already contains the angle $\theta$.

**(b) Sharpness of the bound $n-1$ at $n=3$.** From $T=(100^\circ,50^\circ,30^\circ)$ with
$\theta=60^\circ$, Mulan needs two cuts ($=n-1$), so the bound of Proposition 3 is attained there. To
see that she cannot win in one cut, note that a cut with apex $V$ and parameter $x\in(0^\circ,V)$
produces the pieces $\{q,x,V+r-x\}$ and $\{r,V-x,q+x\}$, where $\{q,r\}$ are the other two angles;
listing, for the triangle's angles $(100^\circ,50^\circ,30^\circ)$, the parameters for which a piece
contains the angle $60^\circ$ (where one of the two pieces is never dangerous, only that piece is
recorded, which is all the argument uses):

* apex $100^\circ$ (with $q=50^\circ$, $r=30^\circ$): the $q$-piece contains $60^\circ$ exactly for
  $x\in\{60^\circ,70^\circ\}$, the $r$-piece exactly for $x\in\{10^\circ,40^\circ\}$ — disjoint
  sets;
* apex $50^\circ$ (with $q=30^\circ$, $r=100^\circ$): the $q$-piece never contains $60^\circ$ (its
  angles are $30^\circ,x,150^\circ-x$ with $x\in(0^\circ,50^\circ)$);
* apex $30^\circ$ (with $q=100^\circ$, $r=50^\circ$): the $r$-piece never contains $60^\circ$ (its
  angles are $50^\circ,30^\circ-x,100^\circ+x$).

So for every legal cut one of the two pieces is free of the angle $60^\circ$, Shan-Yu keeps it, and
the game has not stopped after one cut. (Two cuts always suffice, by Proposition 3.)

**(c) $\theta=90^\circ$ ($n=2$).** Here Proposition 3 does not apply ($\theta>60^\circ$), and
Proposition 4 treats this case with a different cut, $x=90^\circ-B$ at a largest-angle vertex.
Mulan wins in one cut; the value $\theta=90^\circ$ is in the answer set.

**(d) $\theta>90^\circ$.** Then $180^\circ/\theta\in(1,2)$ is not an integer, so by Theorem 9 Shan-Yu
survives. Direct illustration of the same fact: if $\theta>90^\circ$ then $2\theta>180^\circ$, so no
angle of a triangle can equal $m\theta$ for any $m\ge2$, i.e. $\theta\mathbb Z_{>0}\cap(0^\circ,180^\circ)=\{\theta\}$;
in Lemma 8's four cases necessarily $m=p=1$, giving respectively $A=2\theta>180^\circ$ (impossible
for an angle), $B=0$, $C=0$ (impossible) and $180^\circ=2\theta$, i.e. $\theta=90^\circ$ (excluded).
So no cut of any safe triangle puts the angle $\theta$ into both pieces.

**(e) Non-degeneracy is preserved automatically.** Shan-Yu's initial triangle is a genuine triangle
by the hypothesis, and every cut runs from a vertex to a relative-interior point of the opposite
side; the two pieces are then genuine triangles, as recorded in Lemma 1, where all angles of both
pieces are shown to be strictly positive. Hence no angle $0^\circ$ or $180^\circ$ ever occurs, and
membership in $\theta\mathbb Z_{>0}$ is never decided by a degenerate or boundary angle. In
particular the strict inequalities $0^\circ<x<A$ of (0.4) and the strict ones in Steps 2–4 of
Proposition 3 are never equalities.

**(f) Small $\theta$, and the shape of the answer set.** The answer set $\{180^\circ/n:n\ge2\}$
contains arbitrarily small values, and if $\theta=180^\circ/n$ is winning then so is
$\theta/k=180^\circ/(nk)$ for every positive integer $k$ (indeed
$180^\circ/(\theta/k)=k\cdot(180^\circ/\theta)=kn\in\mathbb Z$ and $kn\ge2$). The answer set
accumulates only at $0$: in any interval $[a,b]$ with $a>0$ there are only finitely many numbers of
the form $180^\circ/n$ (namely those with $n\le180^\circ/a$), while the interval contains
infinitely many reals. Hence the answer set contains no interval of positive length, and each of its
elements is a limit of non-winning values: winning is not a stable property under small
perturbations of $\theta$. The answer set is thus discrete with $0$ as its only accumulation point,
and it is contained in $(0^\circ,90^\circ]$.

**(g) Mulan's winning strategy works from every triangle.** This is stronger than the requirement
"no matter how Shan-Yu plays", which only asks for a strategy after Shan-Yu's chosen initial
triangle; but it is what Propositions 3 and 4 establish, since the initial triangle there is
arbitrary.

### 5. Conclusion

Combining the two parts:

* If $\theta=\dfrac{180^\circ}{n}$ for some integer $n\ge2$, then by Corollary 5 Mulan has an explicit
  strategy that, from every initial triangle and against every choice of Shan-Yu, wins in at most
  $n-1$ cuts — finitely many (Propositions 3 and 4 give the strategy; Lemmas 1 and 2 supply the
  ingredients).

* If $180^\circ/\theta$ is not an integer, then by Theorem 9 Shan-Yu has a strategy — open with an
  equilateral triangle, and thereafter always keep a safe piece, which Lemma 8 guarantees exists —
  under which no current triangle ever has an angle exactly $\theta$; the game never stops, so Mulan
  cannot guarantee her victory.

Therefore Mulan can guarantee her victory in finitely many steps, no matter how Shan-Yu plays, if and
only if

$$\theta=\frac{180^\circ}{n}\quad\text{for some integer }n\ge2,
\qquad\text{equivalently}\qquad \frac{180^\circ}{\theta}\in\mathbb Z,\ \frac{180^\circ}{\theta}\ge2. \qquad\blacksquare$$
