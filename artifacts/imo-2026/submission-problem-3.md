# IMO 2026 — Problem 3

## Problem

> Let $n$ be a positive integer. Liu Bang and Xiang Yu have a stick of length $1$ and want to divide it
> between themselves. Liu marks at most $n$ points on the stick, and then Xiang marks at most $n$ points on
> the stick. The marked points are distinct. Then, the stick is cut at all marked points, creating a number of
> pieces. Afterwards, they take turns claiming any unclaimed piece of the stick, with Liu going first. Each
> player's goal is to maximise the total length of their own pieces.
>
> For each $n$, determine the largest value $c$ such that Liu may guarantee a total length of at least $c$,
> regardless of Xiang's play.

Here $c_n$ denotes the value of this game, i.e. the total length Liu obtains when both players play optimally;
equivalently (see §4) $c_n$ is the largest total Liu can guarantee, and also the smallest total to which
Xiang can hold him. **Reading of the rules.** Every mark is placed in the interior of a current piece of the
stick, so marked points are automatically distinct; a "cut" always means such a mark.

**Answer.**
$$c_n=\frac{2^{n}}{2^{n+1}-1}=\frac12\Bigl(1+\frac{1}{2^{n+1}-1}\Bigr)\qquad\text{for every }n\ge1,$$
and the proof below in fact gives the same formula for $n=0$ (where both players mark nothing and $c_0=1$).
The value is attained by Liu's geometric partition into segments $2^nu,2^{n-1}u,\dots,2u,u$ with
$u=1/(2^{n+1}-1)$ (§3.1), against which Xiang's reply of Remark 2.6 forces exactly $A=u$.

**Plan of the proof.** §1 develops the tools: the claiming game with which the process ends has value
$(1+A)/2$, where $A$ is the alternating sum of the final pieces (Lemma 1.1), and the effect of an extra mark
on $A$ is a simple toggle rule (Lemmas 1.3–1.7). §2 proves the upper bound $c_n\le2^n/(2^{n+1}-1)$ (pigeonhole
lemma 2.2, realizability lemma 2.3, (U-core) = Theorem 2.4, assembly = Theorem 2.5). §3 proves the lower bound
for all $n$: against Liu's geometric configuration every legal reply leaves $A\ge u$ (peel induction,
Theorem 3.3 and Corollary 3.4), the one surviving case of the induction being the statement $(\mathrm T)_m$,
which is proved for every $m$ by the box–pairing–graph argument of §3.4 (Theorem 3.10). §4 assembles the
two bounds.

**Notation recap (letters reused across sections).** $S$: a configuration (multiset of pieces) in
§1.4–§2; the *statement* $(\mathrm S)_n$ ("every refinement of $L_n$ with at most $n$ cuts has $A\ge1$")
from §3 on. $T$: a subset of a visible multiset, in signed sums, in §2.1; the *statement*
$(\mathrm T)_m$ ("every refinement $Q$ of $L_m$ with at most $m+1$ cuts has $A(2Q\cup\{1\})\ge1$") from
§3 on. $V$: the multiset of final pieces in §1.1 (with $N_V$, $O_V$); the function $V_k(S)$ of
§1.4–§2.3. $m$: the number of pieces in §1–§2; the index of $L_m$ and $(\mathrm T)_m$ in §3 (the symbol
$S_{*}$ of §3.4 is local and unrelated).

---

## 1. The claiming game and the functional $A$

### 1.1 The claiming game

Let the final pieces form the multiset $V=\{v_1\ge v_2\ge\cdots\ge v_m>0\}$ of positive reals of total mass
$\sigma:=\sum_{i}v_i$. In the claiming game the two players alternately claim one still unclaimed piece,
starting with the player to move, each maximising the total length of the pieces he claims. Put
$$S_1:=v_1+v_3+v_5+\cdots,\qquad S_2:=v_2+v_4+v_6+\cdots,\qquad S_1+S_2=\sigma$$
(so $S_1=v_1$, $S_2=0$ when $m=1$). Finally put
$$A(V):=v_1-v_2+v_3-\cdots+(-1)^{m+1}v_m=S_1-S_2=2S_1-\sigma .$$

**Lemma 1.1 (value of the claiming game).** *The value of the claiming game for the player to move is $S_1$,
and the other player can guarantee $S_2$. Consequently the first player's optimal total is
$S_1=(\sigma+A(V))/2$, and taking a currently longest piece is an optimal first move.*

*Proof.* (i) *The second player can guarantee $S_2$.* If $m\ge2$, put $k:=\lfloor m/2\rfloor$ and consider the
$k$ disjoint pairs
$$\{v_1,v_2\},\ \{v_3,v_4\},\ \dots,\ \{v_{2k-1},v_{2k}\} ;$$
if $m=2k+1$, the piece $v_m=v_{2k+1}$ is left unpaired (if $m=1$ there is nothing to prove). The second
player uses the following strategy: *if the piece just taken by the first player has a partner and that
partner is still unclaimed, take the partner; otherwise take any unclaimed piece.* This is always legal: when
the second player is to make his $t$-th move, exactly $2t-1$ pieces have been taken and
$2t-1\le2k-1<m$, so an unclaimed piece exists; and if the partner of the piece just taken is unclaimed, then
the partner is a legal move.
*Claim.* The second player obtains at least one piece from every pair. Suppose not: some pair has both its
pieces eventually taken by the first player; consider the first moment at which he takes one of them. At that
moment the partner is unclaimed — by assumption the second player never takes a piece of this pair — so by the
strategy the second player takes the partner immediately, after which the partner is no longer available to
the first player. Contradiction.
Now the two pieces of the $i$-th pair have lengths $\ge v_{2i}$, so the second player's total is at least
$\sum_{i=1}^{k}v_{2i}=S_2$. (He makes exactly $k$ moves and takes at least one piece from each of the $k$
disjoint pairs; hence he takes exactly one piece from each pair and, in particular, never takes the unpaired
piece when $m$ is odd.)

(ii) *The first player can guarantee $S_1$.* He takes $v_1$. In the residual game on the multiset
$\{v_2,\dots,v_m\}$ his opponent moves first; by (i) applied to that multiset, the *second* player of the
residual game — that is, the original first player — receives at least the corresponding $S_2$, namely
$v_3+v_5+\cdots$. His total is therefore at least $v_1+v_3+v_5+\cdots=S_1$.

By (i) and (ii) the player to move has value exactly $S_1$; the argument in (ii), with $v_1$ replaced by any
currently largest remaining piece, shows that taking a largest piece is an optimal first move. $\square$

### 1.2 The pairing identity and the level identity

**Lemma 1.2 (pairing/matching identity).** *For every piece multiset $V$ of total mass $\sigma$,*
$$A(V)\;=\;\min_{\pi}\Bigl(\sum_{\{a,b\}\in\pi}|a-b|\;+\;\ell(\pi)\Bigr),$$
*the minimum running over all pairings $\pi$ of $V$ in which every piece is paired, except that if $m$ is odd
exactly one piece is left unpaired, its length $\ell(\pi)$ being added ($\ell(\pi):=0$ if $m$ is even). The
minimum is attained: the sorted pairing $\{v_1,v_2\},\{v_3,v_4\},\dots$, with $v_m$ left unpaired when $m$ is
odd, has cost exactly $A(V)$.*

*Proof.* *($\ge$)* The sorted pairing has cost $\sum_{i}(v_{2i-1}-v_{2i})$, plus $v_m$ if $m$ is odd; that sum
is the alternating sum $A(V)$.

*($\le$)* Let a near-perfect pairing $\pi$ be given. Write its pairs as $\{a_i,b_i\}$ with $a_i\le b_i$, and let
$c$ be the length of the unpaired piece ($c:=0$ when $m$ is even), so that $\sigma=\sum_i(a_i+b_i)+c$. Xiang
plays second and uses the partner strategy of Lemma 1.1(i) with respect to $\pi$ (take the partner of Liu's
last piece if it is unclaimed, otherwise any unclaimed piece; legality is the counting argument given there).
By the claim proved there, Liu never obtains both members of a pair, so Xiang obtains at least one piece of
each pair, i.e. at least $\sum_i a_i$ in total; and Xiang also never takes the unpaired piece, since he makes
exactly $\lfloor m/2\rfloor$ moves and takes one piece from each of the $\lfloor m/2\rfloor$ pairs. Hence,
under this strategy of Xiang, Liu's total is at most $\sigma-\sum_i a_i$; therefore the first player's value
$T'$ (Lemma 1.1) satisfies $T'\le\sigma-\sum_i a_i$. As $A(V)=2T'-\sigma$ by Lemma 1.1,
$$A(V)\;\le\;2\Bigl(\sigma-\sum_i a_i\Bigr)-\sigma\;=\;\sigma-2\sum_i a_i
\;=\;\sum_i(b_i-a_i)+c\;\le\;\sum_i|a_i-b_i|+c ,$$
the middle equality using $\sigma=\sum_i(a_i+b_i)+c$. $\square$

**Lemma 1.3 (level/parity identity).** *For a piece multiset $V$ and a level $x\ge0$ put
$$N_V(x):=\#\{v\in V:\ v>x\},\qquad O_V:=\{x\ge0:\ N_V(x)\ \text{is odd}\}.$$
Then $O_V$ is a finite union of half-open intervals and*
$$A(V)\;=\;\int_0^\infty\mathbf 1\bigl[N_V(x)\ \text{odd}\bigr]\,dx\;=\;|O_V| .$$
*In particular $A(V)\ge0$.*

*Proof.* Let $p_1\ge p_2\ge\cdots\ge p_m$ be the pieces and $p_{m+1}:=0$. For $k=0,\dots,m-1$ the level set
$\{x:N_V(x)>k\}$ has measure $p_{k+1}$, and it has measure $0$ for $k\ge m$. Hence
$$A(V)=\sum_{k\ge0}(-1)^kp_{k+1}
=\int_0^\infty\sum_{k\ge0}(-1)^k\mathbf 1\bigl[N_V(x)>k\bigr]\,dx
=\int_0^\infty\mathbf 1\bigl[N_V(x)\ \text{odd}\bigr]\,dx,$$
because for an integer $N\ge0$ one has $\sum_{k=0}^{N-1}(-1)^k=\mathbf 1[N\ \text{odd}]$, and
$\mathbf 1[N_V(x)>k]=0$ for $k\ge N_V(x)$. $\square$

**Lemma 1.4 (cut toggle).** *Suppose one piece of length $\ell$ of a configuration is cut into two pieces of
lengths $a\le b$, with $a+b=\ell$, all other pieces being unchanged. Let $O$ be the odd level set of the old
configuration, and put $E:=[0,a)\cup[b,\ell)$. Then the odd level set of the new configuration is
$O\triangle E$; consequently*
$$A_{\mathrm{new}}=|O\triangle E|=A_{\mathrm{old}}+|E|-2|O\cap E| .$$

*Proof.* Only the cut piece changes the counting function: its contribution to $N(x)$ changes from
$\mathbf 1[x<\ell]$ into $\mathbf 1[x<a]+\mathbf 1[x<b]$. The difference is $+1$ for $x<a$, $0$ for
$a\le x<b$, $-1$ for $b\le x<\ell$ and $0$ for $x\ge\ell$. So the parity of $N(x)$ flips exactly for
$x\in E$, and Lemma 1.3 gives both displayed formulas. $\square$

### 1.3 Cancellation, scaling, merging

Throughout, $\sqcup$ denotes multiset union, and $\lambda V$ denotes the multiset obtained from a piece
multiset $V$ by multiplying every element by $\lambda$.

**Lemma 1.5.** *Let $V,W$ be piece multisets, $x>0$, $\lambda>0$.*
*(i) $A(V\sqcup\{x,x\})=A(V)$. Consequently $A$ depends only on the multiset $R(V)$ of those lengths that
occur an odd number of times; its elements are pairwise distinct, and $A(V)$ is the alternating sum of
$R(V)$ in decreasing order (the "visible multiset" of $V$).*
*(ii) $O_{\lambda V}=\lambda O_V$ and $A(\lambda V)=\lambda A(V)$.*
*(iii) $O_{V\sqcup W}=O_V\triangle O_W$; consequently $A(V\sqcup W)\ge A(V)-A(W)$ and
$A(V\sqcup W)\le A(V)+A(W)$.*
*(iv) $A(V)\le\max V\le\sum_{v\in V}v$, with the convention $\max\emptyset:=0$ (so $A(\emptyset)=0$).*

*Proof.* (i) For every level $t$ one has $N_{V\sqcup\{x,x\}}(t)=N_V(t)+2\cdot\mathbf 1[t<x]$, so the parity
of the counting function is unchanged; by Lemma 1.3, $O$ and hence $A$ are unchanged. Removing odd
multiplicities pair by pair, we are left with exactly the multiset $R(V)$ of values of odd multiplicity, and
$A$ of that multiset is its alternating sum by the definition of $A$.
(ii) $N_{\lambda V}(t)=N_V(t/\lambda)$ for all $t$, so $t\in O_{\lambda V}\iff t/\lambda\in O_V$, giving
$O_{\lambda V}=\lambda O_V$; substituting $t=\lambda s$ in the integral of Lemma 1.3 gives
$A(\lambda V)=\lambda A(V)$.
(iii) $N_{V\sqcup W}=N_V+N_W$ pointwise, and a sum of two integers is odd exactly when exactly one of the two
summands is odd; hence $O_{V\sqcup W}=O_V\triangle O_W$. The two inequalities are
$|X\triangle Z|\ge|X|-|Z|$ and $|X\triangle Z|\le|X|+|Z|$ together with Lemma 1.3.
(iv) Writing $V=\{v_1\ge\cdots\ge v_m\}$, we have
$A=v_1-(v_2-v_3)-(v_4-v_5)-\cdots\le v_1$, since the brackets are non-negative; and $v_1\le\sum_i v_i$. $\square$

### 1.4 Xiang's marks: the toggle calculus and the token game

A *configuration* is a multiset $P$ of pieces into which the stick has been divided by distinct marks. By
Lemma 1.5(i) the number $A(P)$ depends only on the visible multiset $R(P)$; by Lemma 1.1 this is the only
data of $P$ that matters for the claiming game. If $x\in R(P)$, then a piece of length $x$ is present in $P$.

**Lemma 1.6 (mark calculus).** *Let one mark cut a piece of length $x$ of the configuration $P$ into two
pieces of lengths $y$ and $x-y$ (so $0<y<x$), all other pieces unchanged. Then the visible multiset changes by
the rule*
$$R\ \longmapsto\ R\triangle\{x,\ y,\ x-y\}$$
*(the parity of the multiplicity of each of the three values is toggled; if two of the three values coincide,
the two toggles cancel). In particular:*
*(a) (halving) if $y=x-y=x/2$ and $x\in R$, then $R\mapsto R\setminus\{x\}$;*
*(b) (fold at a visible value) if $x\in R$ and $y\in R$ with $x>y$, then $R\mapsto R\triangle\{x,y,x-y\}$;
if $x=2y$ this fold is the halving move (a).*

*Proof.* Cutting a piece of length $x$ lowers the multiplicity of the value $x$ by $1$ and raises the
multiplicities of the values $y$ and $x-y$ by $1$ each. Toggling the parity of the multiplicity of a value is
exactly symmetric difference of the visible multiset, by Lemma 1.5(i). In (a) the value $y=x-y$ is toggled
twice, so the two toggles cancel and $R\triangle\{x\}=R\setminus\{x\}$. $\square$

**Lemma 1.7 (token game; budget reduction).** *Let $S$ be a configuration with visible multiset $R=R(S)$,
$j:=|R|$. Call a token move on a finite set $R$ of pairwise distinct positive reals either*
* *(delete) $R\mapsto R\setminus\{x\}$ for some $x\in R$, or*
* *(fold) $R\mapsto R\triangle\{x,y,x-y\}$ for some $x,y\in R$ with $x>y$*
*(here the three toggles are toggles of the multiplicities' parities as in Lemma 1.6, not a set difference;
if $x=2y$ the two toggles of the value $y$ cancel and the fold is the halving move of Lemma 1.6(a), i.e. the
deletion of $x$; the result is again a set of pairwise distinct positive reals). Let $G_k(R)$ be the minimum
of $A$ over all sets of positive reals reachable from $R$ by at most $k$ token moves, and let $V_k(S)$ be the
minimum of $A$ over all configurations obtainable from $S$ by at most $k$ marks. Then*
*(i) $V_k(S)\le G_k(R)$ for every $k\ge0$, and*
*(ii) $V_k(S)=0$ for every $k\ge j$.*

*Proof.* (i) Realise the sequence of token moves attaining $G_k(R)$, one mark per move, using Lemma 1.6: each
move acts on values that are visible before it, so at that moment a piece of the required length is present,
and the mark can be placed in its interior. Each token move changes the visible multiset exactly into its
successor in the sequence, so after the sequence the configuration has visible multiset exactly the reached
set $R'$, and its $A$ equals $A(R')=G_k(R)$ by Lemma 1.5(i). At most $k$ marks were used, so
$V_k(S)\le G_k(R)$.
(ii) Halving the pieces of the successive elements of $R$ uses one mark per element and removes that element
from the visible multiset (Lemma 1.6(a)); after $j\le k$ marks the visible multiset is empty and $A=0$. Since
$A\ge0$ always (Lemma 1.3), $V_k(S)=0$. $\square$

---

## 2. The upper bound: Xiang's counter-strategy

Throughout §2, $S$ is a multiset of $m\ge1$ positive reals of total mass $\sigma$ (in the application $S$ is
the multiset of lengths of Liu's segments, so $\sigma=1$ and $m\le n+1$). Any such multiset may be regarded
as a configuration, by arranging its elements as consecutive pieces of a stick of length $\sigma$: a
*refinement of $S$ by $k$ marks* is then simply a multiset obtained by cutting the pieces of $S$ at $k$ further
points, i.e. a multiset $P$ containing the pieces of $S$ subdivided, with $|P|=|S|+k$. Recall that $V_k(S)$
(Lemma 1.7) is the least value of $A$ over all refinements of $S$ by at most $k$ marks.

**Definition 2.1 (minimum signed subset sum).** For a set $R$ of distinct positive reals put
$$\min\mathrm{SSS}(R):=\min\Bigl\{\Bigl|\sum_{t\in T}\epsilon_t t\Bigr|\ :\ \emptyset\ne T\subseteq R,\
\epsilon_t\in\{\pm1\}\ \text{for }t\in T\Bigr\}.$$

### 2.1 The pigeonhole lemma

**Lemma 2.2 (pigeonhole).** *For every set $R$ of $m\ge1$ distinct positive reals of total mass $\sigma$,*
$$\min\mathrm{SSS}(R)\ \le\ \frac{\sigma}{2^m-1}.$$

*Proof.* The $2^m$ subsets $X\subseteq R$ have subset sums $s(X):=\sum_{t\in X}t$ lying in $[0,\sigma]$. List
them in non-decreasing order, $s_1\le s_2\le\cdots\le s_{2^m}$. Then
$$\sum_{i=1}^{2^m-1}(s_{i+1}-s_i)=s_{2^m}-s_1\le\sigma ,$$
so some consecutive gap satisfies $0\le s_{i+1}-s_i\le\sigma/(2^m-1)$. The two corresponding subsets $X,Y$
are distinct, so $T:=X\triangle Y\ne\emptyset$, and
$$s(X)-s(Y)=\sum_{t\in X\setminus Y}t-\sum_{t\in Y\setminus X}t$$
is a signed sum over $T$ with coefficients $\pm1$. Hence $\min\mathrm{SSS}(R)\le\sigma/(2^m-1)$. $\square$

### 2.2 From a signed sum to a strategy

**Lemma 2.3 (realizability).** *For every set $R$ of $m\ge1$ distinct positive reals,*
$$G_{m-1}(R)\ \le\ \min\mathrm{SSS}(R).$$

*Proof* (strong induction on $m$). For $m=1$: $G_0(\{x\})=A(\{x\})=x=\min\mathrm{SSS}(\{x\})$.

Let $m\ge2$, and let $\emptyset\ne T\subseteq R$ together with signs
$\epsilon=(\epsilon_t)_{t\in T}\in\{\pm1\}^T$ realise the value
$$v^{*}:=\min\mathrm{SSS}(R)=\Bigl|\sum_{t\in T}\epsilon_tt\Bigr| .$$

*Case 1: $T\subsetneq R$.* Xiang deletes the $m-|T|$ tokens of $R\setminus T$, one mark each (Lemma 1.7(i));
the visible multiset is now $T$, and $m-1-(m-|T|)=|T|-1$ marks remain. Since $1\le|T|<m$, the induction
hypothesis applies to $T$ and gives $G_{|T|-1}(T)\le\min\mathrm{SSS}(T)\le v^{*}$, because $(T,\epsilon)$ is
itself an admissible signed sum for the set $T$. Hence $G_{m-1}(R)\le v^{*}$ with exactly $m-1$ marks in total.

*Case 2: $T=R$.* If all signs $\epsilon_t$ are equal, then $v^{*}=\sigma$ and, using no move at all,
$G_{m-1}(R)\le A(R)\le\sigma=v^{*}$ (Lemma 1.5(iv)). So assume that $\epsilon_i\ne\epsilon_j$ for some
$i\ne j$; then $\epsilon_i=-\epsilon_j$, and after interchanging $i$ and $j$ if necessary (which preserves
$\epsilon_i=-\epsilon_j$) we may assume $x_i>x_j$. Fold $x_i$ at $x_j$ (Lemma 1.6(b)): one mark cuts a piece
of length $x_i$ into pieces of lengths $x_j$ and $d:=x_i-x_j>0$. Put $R':=R\triangle\{x_i,x_j,d\}$. Three
mutually exclusive sub-cases remain.

*Sub-case 2a: $d=x_j$ (equivalently $x_i=2x_j$; the fold is then a halving of $x_i$).* Here the value $d=x_j$
is toggled twice, so
$$R'=R\setminus\{x_i\},\qquad |R'|=m-1 .$$
Since $\epsilon_i=-\epsilon_j$ and $x_i=2x_j$,
$$\epsilon_ix_i+\epsilon_jx_j=\epsilon_i(2x_j-x_j)=\epsilon_ix_j ,$$
and therefore
$$v^{*}=\Bigl|\epsilon_ix_i+\epsilon_jx_j+\sum_{k\ne i,j}\epsilon_kx_k\Bigr|
=\Bigl|\epsilon_ix_j+\sum_{k\ne i,j}\epsilon_kx_k\Bigr| ,$$
which is a signed sum over the set $R'=R\setminus\{x_i\}$: the element $x_j\in R'$ carries the coefficient
$\epsilon_i=\pm1$, each element $x_k\in R'$ with $k\ne i,j$ carries $\epsilon_k=\pm1$, and every element of
$R'$ occurs exactly once (the indices are distinct). Hence $\min\mathrm{SSS}(R')\le v^{*}$; the induction
hypothesis at level $m-1<m$, applied to the set $R'$ of $m-1$ elements, gives
$G_{m-2}(R')\le\min\mathrm{SSS}(R')\le v^{*}$. Together with the mark already used this is
$1+(m-2)=m-1$ marks.

*Sub-case 2b: $d\in R\setminus\{x_i,x_j\}$* (this sub-case can occur only for $m\ge3$, since
$R\setminus\{x_i,x_j\}$ must be non-empty). Then the value $d$ is toggled twice too (once removed, once
added), so
$$R'=R\setminus\{x_i,x_j,d\},\qquad |R'|=m-3 ,$$
and $m-2\ge m-3=|R'|$ marks remain; by Lemma 1.7(ii) they suffice to halve the visible pieces of $R'$ one by
one, leaving $A=0\le v^{*}$. So $G_{m-1}(R)\le v^{*}$.

*Sub-case 2c: $d\notin R$ and $d\ne x_j$* (thus $d$ is a value not attained in $R$; note that $d=x_i$ is
impossible here, because $x_i>x_j$ and $d=x_i$ would give $x_j=2x_i>x_i$). No cancellation occurs, so
$$R'=\bigl(R\setminus\{x_i,x_j\}\bigr)\cup\{d\},\qquad |R'|=m-1 .$$
As $\epsilon_i=-\epsilon_j$, we have $\epsilon_ix_i+\epsilon_jx_j=\pm d$ and therefore
$$v^{*}=\Bigl|\pm d+\sum_{k\ne i,j}\epsilon_kx_k\Bigr| ,$$
a signed sum over $R'$ with coefficients $\pm1$ (the new element $d$ carries the sign $\pm1$, the other
elements of $R'$ carry their $\epsilon_k$). Hence $\min\mathrm{SSS}(R')\le v^{*}$, and the induction hypothesis
at level $m-1<m$ gives $G_{m-2}(R')\le v^{*}$; with the mark already used this is $m-1$ marks.

In every case $G_{m-1}(R)\le v^{*}=\min\mathrm{SSS}(R)$. $\square$

### 2.3 (U-core), and the upper bound for the game

**Theorem 2.4 ((U-core)).** *Let $S$ be a multiset of $m\ge1$ positive reals of total mass $\sigma$, and let
$k\ge m-1$. Then Xiang, using at most $k$ marks, can force $A\le\sigma/(2^m-1)$; that is,
$V_k(S)\le\sigma/(2^m-1)$.*

*Proof.* Let $R=R(S)$ and $j=|R|$; then $j\le m$.
If $j\le m-1\le k$, Xiang halves all $j$ visible pieces and obtains $A=0\le\sigma/(2^m-1)$ (Lemma 1.7(ii)).
If $j=m$, then every value occurs exactly once (a value occurring at least twice would leave at most $m-1$
distinct values), so $S=R$ is a set of $m$ distinct positive reals of total mass $\sigma$, and Lemmas 2.2
and 2.3 give
$$V_k(S)\ \le\ V_{m-1}(S)\ \le\ G_{m-1}(R)\ \le\ \min\mathrm{SSS}(R)\ \le\ \frac{\sigma}{2^m-1},$$
where the first inequality holds because Xiang is free to use fewer than $k$ marks. $\square$

**Theorem 2.5 (upper bound).** *Let $M\ge1$, and suppose Liu has produced a configuration $S$ with $m\le M$
pieces of total length $1$. Then Xiang has a reply using at most $M-1$ marks after which
$A\le1/(2^{M}-1)$. In particular, $c_n\le2^n/(2^{n+1}-1)$ for every $n\ge1$.*

*Proof.* Let $R=R(S)$ and $j=|R|$; then $j\le m\le M$.

*If $j\le M-1$:* Xiang halves the $j$ visible pieces (at most $M-1$ marks); the visible multiset becomes
empty, so $A=0\le1/(2^M-1)$.

*If $j=M$:* then $m=j=M$ and every value occurs exactly once, so $S$ is a set of $M$ distinct positive reals
of total $1$; Theorem 2.4 with $k=M-1$ gives a reply with $A\le1/(2^M-1)$.

In both cases, by Lemma 1.1, Liu's total is
$$\frac{1+A}{2}\ \le\ \frac12\Bigl(1+\frac{1}{2^{M}-1}\Bigr)\ =\ \frac{2^{M-1}}{2^{M}-1}.$$
Liu has $m\le n+1$ segments and Xiang has $n$ marks, i.e. the budget of Theorem 2.5 with $M=n+1$ (so
$M-1=n$); this gives $c_n\le2^n/(2^{n+1}-1)$. $\square$

### 2.4 The bound is attained

**Remark 2.6 (Xiang's optimal reply to the geometric configuration).** *Let
$S=\{2^{m-1}u,2^{m-2}u,\dots,2u,u\}$ with $u>0$ and $m\ge2$, so that $\sigma=(2^m-1)u$. Xiang can force
$A=u$ exactly, using $m-2\le m-1$ marks: he cuts the largest segment $2^{m-1}u$ into the $m-1$ pieces*
$$u,\ 2u,\ 4u,\ \dots,\ 2^{m-3}u,\ (2^{m-2}+1)u .$$
*(For $m=2$ the displayed list has the single entry $2^{m-2}+1=2$, so the "cut" reproduces the same single
piece and no mark is used. In general the cuts are legitimate:
$(1+2+\cdots+2^{m-3})+(2^{m-2}+1)=2^{m-1}$ in units of $u$, and $m-2$ marks are used, one segment being cut
into $m-1$ pieces.) For $m=1$, no mark is needed and $A=\sigma=u$.*

*Proof.* The untouched segments are $2^{m-2}u,2^{m-3}u,\dots,2u,u$, and the pieces produced from the largest
segment are $u,2u,\dots,2^{m-3}u$ together with $(2^{m-2}+1)u$. Hence, in units of $u$, each of the values
$1,2,4,\dots,2^{m-3}$ occurs exactly twice (once as an untouched segment and once as a piece of the cut
segment), while the value $2^{m-2}$ occurs once (the remaining untouched segment) and the value
$2^{m-2}+1$ occurs once. (For $m=2$ the first statement is vacuous and the two remaining values are
$2^{m-2}=1$ and $2^{m-2}+1=2$, each occurring once.) Thus the visible multiset is
$\{2^{m-2},2^{m-2}+1\}$ in units of $u$, and by Lemma 1.5(i)
$$A=(2^{m-2}+1)u-2^{m-2}u=u=\frac{\sigma}{2^m-1}. \qquad\square$$

So the bound $A\le\sigma/(2^m-1)$ of Theorem 2.4 is attained for this configuration; together with the lower
bound of §3 (which gives $A\ge u$ for *every* reply, in the case $m=n+1$) it shows that the upper-bound
constant of Theorem 2.4 is exactly sharp. For Liu's geometric configuration of §3.1
($m=n+1$, $u=1/(2^{n+1}-1)$) this reply leaves Liu the total $(1+u)/2=2^n/(2^{n+1}-1)$; the next section shows
that Liu can guarantee at least that much.

---

## 3. The lower bound: Liu's geometric configuration

### 3.1 Liu's strategy, and the statements to be proved

Fix $n\ge1$ and put
$$u:=\frac{1}{2^{n+1}-1}.$$
Liu marks the $n$ points
$$2^nu,\quad (2^n+2^{n-1})u,\quad\dots,\quad(2^{n+1}-2)u$$
of the interval $(0,1)$ (there are $n$ of them; the last one is $<1$ because $2^{n+1}-2<2^{n+1}-1$). They cut
the stick into the $n+1$ segments
$$2^nu,\ 2^{n-1}u,\ \dots,\ 2u,\ u,\qquad\text{of total }(2^{n+1}-1)u=1 .$$
In units of $u$, Liu's segment multiset is
$$L_n:=\{2^n,\ 2^{n-1},\ \dots,\ 2,\ 1\},\qquad \sum L_n=2^{n+1}-1 .$$
Let $P$ be the final piece multiset after Xiang's reply (Xiang may place at most $n$ further marks). By
Lemmas 1.1 and 1.5(ii), Liu's total under optimal play is
$$\tfrac12\bigl(1+A(P)\bigr)=\tfrac12\bigl(1+u\cdot A(u^{-1}P)\bigr).$$
Hence the following statement implies $c_n\ge\frac12(1+u)=2^n/(2^{n+1}-1)$:

> **$(\mathrm S)_n$.** *Every refinement $P$ of $L_n$ obtained by at most $n$ cuts satisfies $A(P)\ge1$.*

Here a *refinement of $L_n$ with $r$ cuts* is a configuration obtained by cutting the $n+1$ segments of $L_n$
at $r$ further points (distinct reals, distinct from the existing endpoints); it has $n+1+r$ pieces. We write
$k_i$ for the number of pieces into which the $i$-th *smallest* segment of $L_n$ is cut, so that
$\sum_{i=1}^{n+1}(k_i-1)=r$.

The inductive step (Theorem 3.3) leaves exactly one family of configurations untreated, and that family
reduces to the following one-parameter statement, which is the heart of the proof:

> **$(\mathrm T)_m$.** *Every refinement $Q$ of $L_m$ by at most $m+1$ cuts satisfies
> $A(2Q\cup\{1\})\ge1$* (equivalently, $A(Q\sqcup\{\tfrac12\})\ge\tfrac12$).

### 3.2 The peel lemma and its bookkeeping

**Lemma 3.1 (peel).** *Let $n\ge1$ and $1\le t\le n$. In $L_n$ the $t$ smallest segments are
$2^{t-1},\dots,2,1$, of total $2^t-1$, and the remaining $n-t+1$ segments are $2^n,\dots,2^t$, which are
exactly $2^t\cdot L_{n-t}$. Let $P$ be a refinement of $L_n$, write $Y_t$ for the multiset of pieces lying in
the $t$ smallest segments, and let $Q_t$ be the multiset of pieces lying in the other $n-t+1$ segments, each
divided by $2^t$ (so $Q_t$ is a refinement of $L_{n-t}$ and $P=2^tQ_t\sqcup Y_t$, $\sum Y_t=2^t-1$). Then*
$$A(P)=\bigl|2^tO_{Q_t}\triangle O_{Y_t}\bigr|\ \ge\ 2^tA(Q_t)-A(Y_t)\ \ge\ 2^tA(Q_t)-(2^t-1).$$

*Proof.* $2^tQ_t$ has odd level set $2^tO_{Q_t}$ (Lemma 1.5(ii)), and $P=(2^tQ_t)\sqcup Y_t$, so
$A(P)=|O_{2^tQ_t}\triangle O_{Y_t}|$ (Lemma 1.5(iii)). By $|X\triangle Z|\ge|X|-|Z|$ this is at least
$|O_{2^tQ_t}|-|O_{Y_t}|=2^tA(Q_t)-A(Y_t)$, and $A(Y_t)\le\sum Y_t=2^t-1$ by Lemma 1.5(iv). $\square$

**Lemma 3.2 (bookkeeping).** *Let $P$ be a refinement of $L_n$ with $r\le n$ cuts; let $k_i$ be the number of
pieces of the $i$-th smallest segment of $L_n$ $(1\le i\le n+1)$; and put*
$$\sigma_t:=k_1+\cdots+k_t-t\quad(1\le t\le n+1),\qquad
\varepsilon_t:=r-\sigma_t-(n-t)\quad(0\le t\le n).$$
*Then $\varepsilon_0=r-n\le0$, $\sigma_{n+1}=r$, and $\varepsilon_t-\varepsilon_{t-1}=2-k_t$ for
$1\le t\le n$. Moreover, for every $1\le t\le n$, the configuration $Q_t$ of Lemma 3.1 is a refinement of
$L_{n-t}$ with exactly $r-\sigma_t$ cuts; in particular, if $\varepsilon_t\le0$, i.e. if $r-\sigma_t\le n-t$,
then $A(Q_t)\ge1$ by $(\mathrm S)_{n-t}$.*

*Proof.* $|P|=(n+1)+r=\sum_{i=1}^{n+1}k_i$ gives $r=\sum_{i=1}^{n+1}(k_i-1)=\sigma_{n+1}$. The stated
relations are immediate: $\varepsilon_0=r-(n-0)=r-n\le0$, and
$\varepsilon_t-\varepsilon_{t-1}=-(\sigma_t-\sigma_{t-1})+1=-(k_t-1)+1=2-k_t$. Finally $\sigma_t$ is exactly
the number of cuts lying in the $t$ smallest segments (a segment cut into $k_i$ pieces receives $k_i-1$ cuts),
so the remaining $r-\sigma_t$ cuts lie in the other $n-t+1$ segments, and the pieces there, divided by $2^t$,
form the refinement $Q_t$ of $L_{n-t}$ (Lemma 3.1). $\square$

### 3.3 The peel induction

**Theorem 3.3 (inductive step).** *Let $n\ge1$, and assume $(\mathrm S)_j$ for all $0\le j\le n-1$ and
$(\mathrm T)_{n-1}$. Then $(\mathrm S)_n$ holds.*

*Proof.* Let $P$ be a refinement of $L_n$ with $r\le n$ cuts.

*Case (a): $\varepsilon_t\le0$ for some $t\in\{1,\dots,n\}$.* Then $r-\sigma_t\le n-t$, so $Q_t$ is a
refinement of $L_{n-t}$ with at most $n-t$ cuts (Lemma 3.2), and $(\mathrm S)_{n-t}$ — applicable because
$n-t\le n-1$ — gives $A(Q_t)\ge1$. By Lemma 3.1,
$$A(P)\ \ge\ 2^tA(Q_t)-(2^t-1)\ \ge\ 2^t-(2^t-1)=1 .$$

*Case (b): $\varepsilon_t\ge1$ for all $t\in\{1,\dots,n\}$.* We show first that $r=n$ and $k_1=1$. Since
$\varepsilon_0\le0$ and $\varepsilon_1=\varepsilon_0+2-k_1\ge1$, we get
$$2-k_1=\varepsilon_1-\varepsilon_0\ \ge\ 1-\varepsilon_0\ \ge\ 1 .$$
As $k_1\ge1$, this forces $k_1=1$ and $2-k_1=1$; hence $\varepsilon_1=\varepsilon_0+1\ge1$, so
$\varepsilon_0\ge0$, and with $\varepsilon_0\le0$ we get $\varepsilon_0=0$, i.e. $r=n$. So the smallest
segment of $L_n$, of length $1$, is uncut; writing $Q$ for the multiset of pieces of the other $n$ segments,
each divided by $2$ (so $Q$ is a refinement of $L_{n-1}$), we have
$$P=\{1\}\sqcup 2Q,\qquad\text{and}\qquad Q\ \text{uses}\ r-\sigma_1=n-(k_1-1)=n\le(n-1)+1\ \text{cuts}.$$
Therefore $A(P)=A(2Q\cup\{1\})\ge1$ by $(\mathrm T)_{n-1}$ (Theorem 3.10 below). $\square$

**Corollary 3.4 ($(\mathrm S)_n$ holds for every $n$; the lower bound).** *Assume $(\mathrm T)_m$ for every
$m\ge0$. Then $(\mathrm S)_n$ holds for every $n\ge0$. Consequently*
$$c_n\ \ge\ \frac{2^n}{2^{n+1}-1}\qquad\text{for every }n\ge0 .$$

*Proof.* Induction on $n$. For $n=0$: $L_0=\{1\}$, the only refinement with at most $0$ cuts is $L_0$ itself,
and $A=1\ge1$. For $n\ge1$, Theorem 3.3 derives $(\mathrm S)_n$ from $(\mathrm S)_0,\dots,(\mathrm S)_{n-1}$
and $(\mathrm T)_{n-1}$; since $(\mathrm T)_m$ is assumed for all $m$, the induction goes through. (The
reference to $(\mathrm T)_{n-1}$ is in that direction only: $(\mathrm T)_m$ is proved independently of
every $(\mathrm S)$-statement in §3.4, by an argument — Theorem 3.10 — that uses neither $(\mathrm S)$ nor
$(\mathrm T)$ for smaller indices, so the dependency is well-founded and the induction is not circular.)
The final claim is the computation of §3.1. $\square$

**Remark 3.5 (the exact surviving family, and a precision).** The configurations not covered by Case (a) of
Theorem 3.3 are exactly those with
$$r=n,\qquad k_1=1,\qquad \sigma_t\le t-1\ \ \text{for all }1\le t\le n$$
(call this family $\mathcal R_n$): Case (b) says $r-\sigma_t\ge n-t+1$ for all $1\le t\le n$, which for $r=n$
is $\sigma_t\le t-1$, and conversely $\sigma_t\le t-1$ for all $1\le t\le n$ gives $\varepsilon_t\ge1$ for all
$1\le t\le n$. Two
remarks on this criterion. First, the peel closes at the first $t\le n$ with $\varepsilon_t\le0$, which is
exactly the condition $r-\sigma_t\le n-t$. For a surviving configuration (Case (b)) we have $r=n$, hence
$\varepsilon_t=t-\sigma_t$; if in addition $k_1=1$ and $t\ge2$ is the first index with $k_t\ge3$, then
$\varepsilon_t=3+\#\{2\le i<t:\ k_i=1\}-k_t$; so the peel closes at such a $t$ precisely when
$$k_t\ \ge\ 3+\#\{2\le i<t:\ k_i=1\}.$$
In particular it closes when *all* the intervening smaller segments are cut into exactly two pieces; but a
segment cut into three or more pieces does not by itself close the peel. For instance, for $n=r=4$ the data
$k=(1,1,3,2,2)$ (the segments of lengths $1$ and $2$ uncut, the segment of length $4$ cut into three pieces)
give $\sigma_1,\dots,\sigma_5=(0,0,2,3,4)$ and $\varepsilon_t=t-\sigma_t=1,2,1,1$ for $t=1,2,3,4$, all of
them $\ge1$; so this configuration belongs to $\mathcal R_n$, the peel does not close at any level, and it is
handled by $(\mathrm T)_3$. The family $\mathcal R_n$ has no simpler description. Second, Case (b) uses only
$k_1=1$ from the definition of $\mathcal R_n$: every surviving
configuration satisfies $P=\{1\}\sqcup2Q$ with $Q$ a refinement of $L_{n-1}$ using $n$ cuts, and such $P$ are
exactly the configurations covered by $(\mathrm T)_{n-1}$.

### 3.4 The engine: boxing, pairing graph, bipartite colour classes

It remains to prove $(\mathrm T)_m$ for every $m$. Fix $m\ge0$ and a refinement $Q$ of $L_m$ by $r\le m+1$
cuts; we must show $A(2Q\cup\{1\})\ge1$. Put
$$X:=Q\sqcup\{\tfrac12\},\qquad s:=m+2 .$$
By Lemma 1.5(ii), $2X=2Q\sqcup\{1\}$, so
$$A(2Q\cup\{1\})=2A(X),$$
and it suffices to prove $A(X)\ge\tfrac12$.

**Definition 3.6 (boxed multiset; pairing graph).** A *boxed multiset* is a multiset $X$ of positive reals
together with a partition $X=B_1\sqcup\cdots\sqcup B_s$ into non-empty parts; the *sum* of the box $B$ is
$c(B):=\sum_{x\in B}x$. Given a near-perfect pairing $\pi$ of $X$ (as in Lemma 1.2), the *pairing graph*
$G$ has as its vertices the $s$ boxes, and one edge for each pair $\{x,y\}\in\pi$, joining the box containing
$x$ to the box containing $y$ (this edge is a *loop* if $x$ and $y$ lie in the same box). We write
$\mathrm{cost}(\pi):=\sum_{\{x,y\}\in\pi}|x-y|$, and for a set $C$ of vertices, $\mathrm{cost}_C(\pi)$ for the
sum of $|x-y|$ over those pairs of $\pi$ with both members in boxes of $C$.

**Lemma 3.7 (count lemma).** *Let $X$ be a multiset of $|X|\le2s-1$ elements, boxed into $s$ boxes, and let
$\pi$ be a near-perfect pairing of $X$ with $t$ pairs. Then $t\le s-1$, and the pairing graph has a component
$C$ such that the pairs with both members in $C$ number exactly $|C|-1$ and none of them is a loop; in other
words, $C$, with those pairs as its edges, is a tree.*

*Proof.* Every pair consists of two elements, so $|X|\ge2t$; hence $2t\le|X|\le2s-1$ and therefore
$t\le s-1$, since $t$ is an integer. Decompose the pairing graph into its connected components $C_1,\dots,C_p$
(loops do not connect). For each $q$ let $n_q:=|C_q|$, let $m_q$ be the number of non-loop edges inside
$C_q$, and let $\ell_q$ be the number of loops at vertices of $C_q$. Every edge lies inside exactly one
component, so
$$\sum_{q=1}^{p}(m_q+\ell_q)=t\ \le\ s-1\ =\ \sum_{q=1}^{p}n_q-1,
\qquad\text{i.e.}\qquad
\sum_{q=1}^{p}(m_q+\ell_q-n_q)\ \le\ -1 .$$
Each component is connected, so $m_q\ge n_q-1$, and hence $m_q+\ell_q-n_q\ge-1$ for every $q$. A sum of
integers, each $\ge-1$, that is $\le-1$ must have a summand equal to $-1$ (were all summands $\ge0$, the sum
would be $\ge0$). For that $q$ we have $m_q+\ell_q=n_q-1$; since $m_q\ge n_q-1$ and $\ell_q\ge0$, this forces
$m_q=n_q-1$ and $\ell_q=0$. So $C_q$ is connected with $n_q$ vertices, exactly $n_q-1$ non-loop edges and no
loop: it is a tree. $\square$

**Lemma 3.8 (bipartite mass bound; free halves).** *Let $C$ be a tree component of the pairing graph (as in
Lemma 3.7), put $N:=|C|$, and let $e_1,\dots,e_{N-1}$ be the pairs with both members in boxes of $C$ (there
are exactly $N-1$ of them and none is a loop); write the two members of $e$ as $x_e$ and $y_e$. Let
$z\ge0$ be the length of the unpaired element of $\pi$ ($z=0$ if there is none). Colour the tree $C$ with two
colours, black and white, so that the two endpoints of every edge receive different colours; let*
$$M_{\mathrm{black}}:=\sum_{v\in C,\ v\ \mathrm{black}}c(v),\qquad
M_{\mathrm{white}}:=\sum_{v\in C,\ v\ \mathrm{white}}c(v),$$
*and define*
$$\phi:=\begin{cases}+z,&\text{if the unpaired element lies in a black box of }C,\\
-z,&\text{if it lies in a white box of }C,\\ 0,&\text{otherwise;}\end{cases}
\qquad\text{so that }|\phi|\le z .$$
*Then*
$$\bigl|M_{\mathrm{black}}-M_{\mathrm{white}}-\phi\bigr|\ \le\ \mathrm{cost}_C(\pi)
=\sum_{e=1}^{N-1}|x_e-y_e| .$$

*Proof.* A tree is bipartite, so the required colouring exists (and is unique up to swapping the two colours).
Every element lying in a box of $C$ is either a member of one of the pairs $e_1,\dots,e_{N-1}$ or
else the unpaired element of $\pi$ (which may or may not lie in a box of $C$): indeed, if such an element is
paired, its partner lies in the box joined to its own box by the corresponding edge of the pairing graph,
hence in the same component $C$, so the pair is one of the $e$'s. Now sum the box sums of $C$ with sign $+1$
on black boxes and $-1$ on white boxes. Each pair $e$ has one member in a black and one in a white box
(the colouring is proper), so its two members contribute $\varepsilon_e(x_e-y_e)$ for some
$\varepsilon_e\in\{\pm1\}$; the unpaired element, if it lies in a box of $C$, contributes exactly $\phi$.
Hence
$$M_{\mathrm{black}}-M_{\mathrm{white}}-\phi=\sum_{e=1}^{N-1}\varepsilon_e(x_e-y_e),$$
and the triangle inequality gives the claim. $\square$

**Lemma 3.9 (dominance of the largest box).** *Let $C$ be a tree component of the pairing graph and let
$v^{*}$ be a box of $C$ of maximum sum $c^{*}:=c(v^{*})$. Colour $C$ so that $v^{*}$ is black, and put
$S_{*}:=\sum_{v\in C,\ v\ne v^{*}}c(v)$ for the total sum of the remaining boxes of $C$.*
*(a) If the box sums are the family $\Pi_m=\{2^m,2^{m-1},\dots,2,1,\tfrac12\}$, then*
$$M_{\mathrm{black}}-M_{\mathrm{white}}\ \ge\ \tfrac12 .$$
*(b) If the box sums are superincreasing, i.e. $c_i>\sum_{j>i}c_j$ for all $i$, then
$M_{\mathrm{black}}-M_{\mathrm{white}}>0$.*

*Proof.* Let $B$ be the total sum of the black boxes of $C$ other than $v^{*}$; the boxes of $C$ other than
$v^{*}$ split into those counted by $B$ and the white ones, of total $S_{*}-B$. Hence
$$M_{\mathrm{black}}=c^{*}+B,\qquad M_{\mathrm{white}}=S_{*}-B,\qquad
M_{\mathrm{black}}-M_{\mathrm{white}}=c^{*}+2B-S_{*}\ \ge\ c^{*}-S_{*} .$$
(a) The box sums of $C$ are distinct elements of $\Pi_m$, and $c^{*}$ is the largest of them. If
$c^{*}=2^j$ ($0\le j\le m$), the sums of $\Pi_m$ strictly below $c^{*}$ are
$2^{j-1},2^{j-2},\dots,2,1$ and also $\tfrac12$, whose total is $(2^j-1)+\tfrac12=c^{*}-\tfrac12$; if
$c^{*}=\tfrac12$, there is no smaller sum in $\Pi_m$ and the total is $0=\tfrac12-\tfrac12$. In either case
$S_{*}\le c^{*}-\tfrac12$, so $M_{\mathrm{black}}-M_{\mathrm{white}}\ge\tfrac12$.
(b) If $c^{*}=c_{i^{*}}$ is the largest of the box sums of $C$, then the other box sums of $C$ are among
$c_{i^{*}+1},\dots,c_s$, so $S_{*}\le\sum_{j>i^{*}}c_j<c_{i^{*}}=c^{*}$; hence
$M_{\mathrm{black}}-M_{\mathrm{white}}\ge c^{*}-S_{*}>0$. $\square$

**Theorem 3.10 ($(\mathrm T)_m$, for every $m$).** *For every $m\ge0$ and every refinement $Q$ of $L_m$ by at
most $m+1$ cuts,*
$$A\bigl(2Q\cup\{1\}\bigr)\ \ge\ 1,\qquad\text{equivalently}\qquad A\bigl(Q\sqcup\{\tfrac12\}\bigr)\ \ge\ \tfrac12 .$$

*Proof.* Let $Q$ be such a refinement, with $r\le m+1$ cuts; put $X:=Q\sqcup\{\tfrac12\}$ and $s:=m+2$. Box
$X$ by the segments of $L_m$:
$$B_j:=\text{the multiset of pieces lying in the segment }2^{m-j}\quad(0\le j\le m),
\qquad B_{m+1}:=\{\tfrac12\}.$$
This is a boxing into $s=m+2$ non-empty boxes whose sums are $2^m,2^{m-1},\dots,2,1,\tfrac12$, i.e. the
family $\Pi_m$ of Lemma 3.9(a). Since $|Q|=(m+1)+r$, we have
$$|X|=|Q|+1=m+2+r\ \le\ m+2+(m+1)=2m+3=2(m+2)-1=2s-1 .$$
Suppose, for contradiction, that $A(X)<\tfrac12$. By the pairing identity (Lemma 1.2) there is a near-perfect
pairing $\pi$ of $X$, with $t$ pairs and unpaired value $z\ge0$, realising the minimum:
$$\mathrm{cost}(\pi)+z=A(X)<\tfrac12 .$$
Since $|X|\le2s-1$, Lemma 3.7 provides a tree component $C$ of the pairing graph. Colour $C$ so that its box
$v^{*}$ of maximum sum is black (Lemma 3.9), whence
$$M_{\mathrm{black}}-M_{\mathrm{white}}\ \ge\ \tfrac12 .$$
By Lemma 3.8, for a suitable $\phi$ with $|\phi|\le z$,
$$\bigl|M_{\mathrm{black}}-M_{\mathrm{white}}-\phi\bigr|\ \le\ \mathrm{cost}_C(\pi)\ \le\ \mathrm{cost}(\pi)$$
(the last inequality because the pairs of $C$ are among the pairs of $\pi$). Therefore
$$\mathrm{cost}(\pi)\ \ge\ \bigl|M_{\mathrm{black}}-M_{\mathrm{white}}-\phi\bigr|
\ \ge\ M_{\mathrm{black}}-M_{\mathrm{white}}-|\phi|\ \ge\ \tfrac12-z ,$$
and consequently
$$A(X)=\mathrm{cost}(\pi)+z\ \ge\ \Bigl(\tfrac12-z\Bigr)+z\ =\ \tfrac12 ,$$
contradicting $A(X)<\tfrac12$. Hence $A(X)\ge\tfrac12$, that is $A(2Q\cup\{1\})\ge1$. $\square$

**Remark 3.11 (sharpness, and what the proof really uses).**
(i) *Sharpness:* take $Q:=L_m/2$, the halving of every one of the $m+1$ segments of $L_m$ (this uses
$m+1$ cuts, the full budget). Then $X=Q\sqcup\{\tfrac12\}$ contains each of the values
$2^{m-1},2^{m-2},\dots,1$ exactly twice and the value $\tfrac12$ exactly three times; hence its visible
multiset is $\{\tfrac12\}$ and $A(X)=\tfrac12$ exactly, i.e. $A(2Q\cup\{1\})=1$. So $(\mathrm T)_m$ is sharp.
(In the minimal pairing one pairs equal values — cost $0$ — and leaves one $\tfrac12$ unpaired, so
$z=\tfrac12$; the isolated box $B_{m+1}=\{\tfrac12\}$ is a tree component of that pairing, and Lemma 3.9(a)
is an equality for it, $M_{\mathrm{black}}-M_{\mathrm{white}}=\tfrac12$.)
(ii) *What is used:* the hypothesis on the number of cuts enters the proof of Theorem 3.10 only through
$|X|\le2s-1$. Thus the argument proves the more general statement that every boxing of a multiset $X$ into
boxes with sums $2^m,2^{m-1},\dots,2,1,\tfrac12$ and $|X|\le2s-1$ (where $s=m+2$) satisfies
$A(X)\ge\tfrac12$. This generality is not needed below.

### 3.5 A by-product proved by the same engine: (CC) and superincreasing boxings

The same argument, in the degenerate case where the pairing consists of equal values, proves the following
statement. (It is not needed for the answer; it is included because it is free and shows that the "parity"
half of the lower bound also holds.)

**Theorem 3.12 ((CC), superincreasing form).** *Let $c_1>\cdots>c_s>0$ be superincreasing, i.e.
$c_i>\sum_{j>i}c_j$ for every $i$, and let $V$ be a multiset of positive reals in which every value occurs an
even number of times. If $V$ can be partitioned into $s$ boxes with sums $c_1,\dots,c_s$, then $|V|\ge2s$.*

*Proof.* Pair the elements of $V$ into the $t:=|V|/2$ pairs of equal values (possible because every value
occurs an even number of times, so $|V|$ is even); this is a near-perfect pairing $\pi$ with
$\mathrm{cost}(\pi)=0$ and no unpaired element ($z=0$, hence $\phi=0$). Suppose $t\le s-1$; then
$|V|=2t\le2s-2\le2s-1$, so Lemma 3.7 gives a tree component $C$ of the pairing graph, and Lemma 3.9(b) gives
$M_{\mathrm{black}}-M_{\mathrm{white}}>0$ for the colouring with the largest box of $C$ black. By Lemma 3.8
(with $z=0$),
$$0\ <\ M_{\mathrm{black}}-M_{\mathrm{white}}\ =\ \bigl|M_{\mathrm{black}}-M_{\mathrm{white}}-\phi\bigr|
\ \le\ \mathrm{cost}_C(\pi)\ \le\ \mathrm{cost}(\pi)=0,$$
because every term $|x_e-y_e|$ vanishes (the two members of each pair are equal). This contradiction shows
$t\ge s$, i.e. $|V|=2t\ge2s$. $\square$

**Corollary 3.13 ((CC)$_n$).** *No refinement of $L_n$ by at most $n$ cuts has all piece multiplicities even.*

*Proof.* The family $(2^n,2^{n-1},\dots,2,1)$ is superincreasing, since
$2^{\,n-i}>\sum_{j>i}2^{\,n-j}=2^{\,n-i}-1$ for every $i$. Box the pieces of a refinement of $L_n$ by their
segments: this gives $s=n+1$ boxes with exactly the sums $2^n,2^{n-1},\dots,1$. If all multiplicities were
even, Theorem 3.12 would give $|P|\ge2(n+1)$; but $|P|=(n+1)+r\le(n+1)+n=2n+1<2n+2$. $\square$

The bound in Corollary 3.13 is sharp: halving every segment of $L_n$ produces $2(n+1)$ pieces of even
multiplicity with $n+1$ cuts. Thus $n+1$ cuts (one more than Xiang's budget) are needed to reach $A=0$.

### 3.6 Sharpness of $(\mathrm S)_n$, and small cases

**Remark 3.14.** (i) *$(\mathrm S)_n$ is sharp.* Use exactly $n$ cuts, halving every segment of $L_n$ except
the smallest: the pieces are, in units of $u$,
$$\{1\}\ \cup\ \{1,1\}\ \cup\ \{2,2\}\ \cup\ \cdots\ \cup\ \{2^{n-1},2^{n-1}\},$$
so the value $1$ occurs three times and every other value exactly twice; hence the visible multiset is
$\{1\}$ and $A=1$ exactly. Therefore, by Corollary 3.4, the minimum of $A$ over refinements of $L_n$ with at
most $n$ cuts is exactly $1$, attained.
(ii) *Budget.* Halving *all* $n+1$ segments of $L_n$ (each segment $2^j$ into $2^{j-1}$ and $2^{j-1}$) gives
a configuration in which every value occurs an even number of times, hence $A=0<1$: with $n+1$ cuts the bound
of $(\mathrm S)_n$ fails, so the budget $n$ is exactly the critical one (compare Corollary 3.13).
(iii) *Small cases.* $n=0$: $L_0=\{1\}$ and no cut is possible, so $A=1$; thus $(\mathrm S)_0$ holds and
$c_0=1$. $n=1$: $L_1=\{2,1\}$ and one checks $A\ge1$ directly — with no cut $A=2-1=1$; a cut of the segment
$2$ into $x$ and $2-x$ ($0<x<2$) gives the pieces $\{x,2-x,1\}$, and $A=1$ for every such $x$: if $x\le1$ the
sorted order is $2-x,1,x$ and $A=(2-x)-1+x=1$, while if $x\ge1$ the sorted order is $x,1,2-x$ and
$A=x-1+(2-x)=1$; a cut of the segment $1$ into $y$ and $1-y$ gives $\{2,1-y,y\}$ with $A=1+2y>1$ for
$0<y\le\tfrac12$ (sorted order $2,1-y,y$) and $A=3-2y>1$ for $\tfrac12\le y<1$ (sorted order $2,y,1-y$).
Hence $(\mathrm S)_1$ holds with equality, and $c_1=\frac23$ by §2 and §3. Also $(\mathrm T)_0$ holds with
equality: for $Q=L_0=\{1\}$ one has $2Q\cup\{1\}=\{2,1\}$ and $A=1$; and for $Q=\{y,1-y\}$ with
$0<y<1$ one has $2Q\cup\{1\}=\{2y,2-2y,1\}$ and $A=1$ (if $2y\le1$ then $2-2y\ge1$ and the sorted order is
$2-2y,1,2y$, giving $A=(2-2y)-1+2y=1$; if $2y\ge1$ then $2-2y\le1$ and the sorted order is $2y,1,2-2y$,
giving $A=2y-1+2-2y=1$).

---

## 4. Conclusion: the value of the game

**Theorem 4.1.** *For every $n\ge0$,*
$$c_n=\frac{2^n}{2^{n+1}-1}.$$

*Proof.* We prove that Liu can guarantee $2^n/(2^{n+1}-1)$ however Xiang replies, and that Xiang can hold
him to at most that number; these two facts are what is meant by "the value of the game" (see Remark 4.2).

*Lower bound (Liu's guarantee).* Let Liu play the configuration of §3.1: the $n$ marks producing the segments
$2^nu,2^{n-1}u,\dots,2u,u$, where $u=1/(2^{n+1}-1)$. Whatever reply Xiang makes with at most $n$ marks, the
resulting refinement $P$ of $L_n$ satisfies $A(u^{-1}P)\ge1$ by Corollary 3.4 (which rests on the peel
induction, Theorem 3.3, and on $(\mathrm T)_m$ for all $m$, Theorem 3.10), that is, $A(P)\ge u$. By
Lemma 1.1, Liu's total under optimal play in the claiming game is then
$$\frac{1+A(P)}{2}\ \ge\ \frac{1+u}{2}=\frac{2^n}{2^{n+1}-1}.$$

*Upper bound (Xiang's counter-strategy).* Let Liu choose any configuration with $m\le n+1$ pieces of total
length $1$. By Theorem 2.5 with $M=n+1$ (Xiang has $M-1=n$ marks available) there is a reply of Xiang after
which $A\le1/(2^{n+1}-1)$; then Liu's total is at most
$$\frac{1+A}{2}\ \le\ \frac12\Bigl(1+\frac{1}{2^{n+1}-1}\Bigr)=\frac{2^n}{2^{n+1}-1}.$$

Since Liu can guarantee $2^n/(2^{n+1}-1)$ and Xiang can prevent him from getting more, the value is
$c_n=2^n/(2^{n+1}-1)$. $\square$

**Remark 4.2 (the value is well defined).** Define
$$c_n:=\sup_{\text{Liu's configurations}}\ \min_{\text{Xiang's replies}}\ \frac{1+A(P)}{2},$$
where the inner minimum is over all replies of Xiang using at most $n$ marks and $P$ is the resulting piece
multiset (Liu's total inside the claiming game is $(1+A(P))/2$ by Lemma 1.1, and the claiming game itself is
optimally played by both). The upper bound (Theorem 2.5) shows that *every* Liu
configuration admits a reply with $A\le1/(2^{n+1}-1)$, so $c_n\le2^n/(2^{n+1}-1)$; the lower bound
(§3.1 + Corollary 3.4) exhibits one Liu configuration against which *every* reply gives $A\ge u$, so
$c_n\ge2^n/(2^{n+1}-1)$. Hence the two bounds pin the value, and no further supremum/infimum subtlety
arises.

**Remark 4.3 (both bounds are attained).** Against Liu's geometric configuration $L_nu$, Xiang's reply of
Remark 2.6 (which uses $m-2=n-1$ marks) yields $A=u$ exactly, hence Liu's total $(1+u)/2$; by Theorem 4.1
this is simultaneously the best Liu can guarantee and the best Xiang can achieve against this configuration.
Thus the geometric partition is an optimal Liu configuration and the reply of Remark 2.6 is an optimal reply
to it, and the value $c_n=2^n/(2^{n+1}-1)$ is attained in this line of play.

---

## Appendix: summary of the logical structure

* **Lemma 1.1** (claiming value) is proved by two explicit guarantees; **Lemma 1.2** (pairing identity),
  **Lemma 1.3** (level identity), **Lemma 1.4** (cut toggle), **Lemma 1.5** (cancellation, scaling, merging),
  **Lemma 1.6** (mark calculus) and **Lemma 1.7** (token game) describe $A$ and the effect of Xiang's marks
  on it completely.
* **Upper bound ($c_n\le2^n/(2^{n+1}-1)$).** Lemma 2.2 (pigeonhole: some non-empty signed subset sum is
  $\le\sigma/(2^m-1)$); Lemma 2.3 (every such signed sum is realised by a token strategy with $m-1$ moves —
  with sub-case 2a, $x_i=2x_j$, treated via the relabelling trick); Theorem 2.4 ((U-core):
  $V_k(S)\le\sigma/(2^m-1)$ for $k\ge m-1$); Theorem 2.5 (case split on the number $j$ of visible pieces:
  $j\le n$ gives $A=0$, while $j=n+1$ forces $m=n+1$ distinct pieces and gives $A\le1/(2^{n+1}-1)$).
  Remark 2.6 shows the bound is attained for the geometric configuration.
* **Lower bound ($c_n\ge2^n/(2^{n+1}-1)$).** Lemma 3.1 (peel) and Lemma 3.2 (bookkeeping) reduce
  $(\mathrm S)_n$ to $(\mathrm S)_{n-t}$ in all cases except the family $\mathcal R_n$, which reduces further
  to $(\mathrm T)_{n-1}$ (Theorem 3.3, Corollary 3.4, Remark 3.5). Theorem 3.10 proves $(\mathrm T)_m$ for
  every $m$ by the box–pairing–graph argument: Lemma 3.7 (few pairs force a tree component), Lemma 3.8 (a
  tree component is bipartite and the imbalance of its colour classes is bounded by its pairing cost),
  Lemma 3.9 (the largest box of a component dominates its colour class by at least the gap $\tfrac12$ of the
  family $\Pi_m$); hence $A\ge\tfrac12$. The by-product is Theorem 3.12/Corollary 3.13 ((CC)$_n$).
* **Assembly.** §3.1 + Corollary 3.4 (lower bound, all $n$) + Theorem 2.5 (upper bound, all Liu
  configurations) give Theorem 4.1: $c_n=2^n/(2^{n+1}-1)$ for every $n\ge0$; Remarks 4.2 and 4.3 record
  well-definedness and attainment.
