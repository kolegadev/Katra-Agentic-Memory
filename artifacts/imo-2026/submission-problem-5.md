# IMO 2026 — Problem 5

## Problem

**Problem 5.** *Let $\mathbb R_{>0}$ be the set of positive real numbers. Determine all functions
$f:\mathbb R_{>0}\to\mathbb R_{>0}$ such that*

$$\sqrt{\frac{x^{2}+f(y)^{2}}{2}}\;\ge\;\frac{f(x)+y}{2}\;\ge\;\sqrt{x\,f(y)}$$

*for every $x,y\in\mathbb R_{>0}$.*

In linear notation the required chain is
$\sqrt{(x^{2}+f(y)^{2})/2}\ \ge\ (f(x)+y)/2\ \ge\ \sqrt{x\,f(y)}$: the first and third terms are
square roots, and the middle term is halved. We write $x,y$ for arbitrary elements of
$\mathbb R_{>0}$; no other restriction on $x,y$ is imposed.

## Answer

$$\boxed{\ f(x)=x+c\quad\text{for every }x>0,\qquad\text{where }c\ge 0\ \text{is a constant.}\ }$$

Thus the solutions are exactly the translations of the positive half-line by a non-negative
constant: the identity map (case $c=0$), and $x\mapsto x+c$ for each $c>0$. There are no others.

## Solution

### 0. Notation, and the pair of squared inequalities

Put $\mathbb R_{>0}=(0,\infty)$. For an integer $k\ge 0$ we write $f^{(k)}$ for the $k$-fold iterate
of $f$, defined by $f^{(0)}(y)=y$ and $f^{(k+1)}(y)=f\bigl(f^{(k)}(y)\bigr)$ for $y>0$. Every
$f^{(k)}(y)$ with $k\ge 1$ is a value of $f$, hence lies in $\mathbb R_{>0}$ and is a legitimate
argument for $f$.

**Lemma 0 (removing the square roots).** *The required chain of inequalities holds for all
$x,y>0$ if and only if*

$$\text{(A)}\quad \bigl(f(x)+y\bigr)^{2}\le 2\bigl(x^{2}+f(y)^{2}\bigr),
\qquad\qquad
\text{(B)}\quad \bigl(f(x)+y\bigr)^{2}\ge 4x\,f(y)$$

*hold for all $x,y>0$.*

*Proof.* Since $f(x),y>0$ we have $(f(x)+y)/2>0$; since $x,f(y)>0$ we have $xf(y)>0$ and
$\sqrt{xf(y)}>0$; and $x^{2}+f(y)^{2}>0$ gives $\sqrt{(x^{2}+f(y)^{2})/2}>0$. Hence all three
quantities in the chain are strictly positive, and on $(0,\infty)$ the map $u\mapsto u^{2}$ is
strictly increasing, so squaring an inequality between positive quantities is an equivalence.

Squaring the left inequality of the chain, $\sqrt{(x^{2}+f(y)^{2})/2}\ \ge\ (f(x)+y)/2$, gives
$(x^{2}+f(y)^{2})/2\ge\bigl(f(x)+y\bigr)^{2}/4$, i.e. (A). Squaring the right inequality
$(f(x)+y)/2\ge\sqrt{xf(y)}$ gives $\bigl(f(x)+y\bigr)^{2}/4\ge xf(y)$, i.e. (B).

Conversely, assume (A) and (B). From (A), taking non-negative square roots of the two sides
$0\le\bigl(f(x)+y\bigr)^{2}\le 2\bigl(x^{2}+f(y)^{2}\bigr)$ and using
$\sqrt{2\bigl(x^{2}+f(y)^{2}\bigr)}=2\sqrt{\bigl(x^{2}+f(y)^{2}\bigr)/2}>0$,
$\sqrt{\bigl(f(x)+y\bigr)^{2}}=f(x)+y$, we get
$f(x)+y\le 2\sqrt{(x^{2}+f(y)^{2})/2}$, i.e. the left inequality of the chain. From (B) we get
$\bigl(f(x)+y\bigr)^{2}\ge 4xf(y)=\bigl(2\sqrt{xf(y)}\bigr)^{2}$ with both sides non-negative, hence
$f(x)+y\ge 2\sqrt{xf(y)}$, i.e. the right inequality of the chain. $\square$

From now on we work only with (A) and (B), required for all $x,y>0$.

### 1. The substitution $x=f(y)$: a forced identity

Fix $y>0$. Because $f(y)>0$, the value $x=f(y)$ is a legitimate argument in (A) and (B).

* (A) with $x=f(y)$: $\bigl(f(f(y))+y\bigr)^{2}\le 2\bigl(f(y)^{2}+f(y)^{2}\bigr)=4f(y)^{2}$.
* (B) with $x=f(y)$: $\bigl(f(f(y))+y\bigr)^{2}\ge 4f(y)\,f(y)=4f(y)^{2}$.

Both quantities $\bigl(f(f(y))+y\bigr)^{2}$ and $4f(y)^{2}$ are non-negative, and
$\sqrt{4f(y)^{2}}=2f(y)$ because $f(y)>0$; taking square roots in the two displayed inequalities
therefore yields $f(f(y))+y\le 2f(y)$ and $f(f(y))+y\ge 2f(y)$, so equality holds:

$$\text{(1)}\qquad f\bigl(f(y)\bigr)=2f(y)-y\qquad\text{for all }y>0 .$$

### 2. The displacement function $c$: invariance, orbits, and non-negativity

Define the displacement

$$c(y):=f(y)-y\qquad(y>0).$$

Subtracting $f(y)$ from both sides of (1) gives
$c\bigl(f(y)\bigr)=f\bigl(f(y)\bigr)-f(y)=\bigl(2f(y)-y\bigr)-f(y)=f(y)-y=c(y)$, that is,

$$\text{(2)}\qquad c\bigl(f(y)\bigr)=c(y)\qquad\text{for all }y>0 .$$

**Iterates.** We claim

$$\text{(3)}\qquad f^{(k)}(y)=y+k\,c(y)\qquad\text{for all integers }k\ge 0\ \text{and all }y>0 .$$

*Proof.* For $k=0$ this is $y=y$; for $k=1$ it is the definition of $c$. Let $k\ge1$ and suppose the
formula holds for $k-1$ and $k$. Put $z:=f^{(k)}(y)$, which is positive, so that (1) may be applied
to $z$:
$$f^{(k+1)}(y)=f\bigl(f(z)\bigr)=2f(z)-z=2f^{(k)}(y)-f^{(k-1)}(y)
=2\bigl(y+kc(y)\bigr)-\bigl(y+(k-1)c(y)\bigr)=y+(k+1)c(y). \qquad\square$$

**Non-negativity of $c$.** Fix $y>0$. For every integer $k\ge0$ the point $f^{(k)}(y)$ lies in
$\mathbb R_{>0}$ (for $k=0$ this is $y>0$; for $k\ge1$ it is a value of $f$). By (3),
$$y+k\,c(y)>0\qquad\text{for every integer }k\ge0 .$$
If $c(y)<0$, then for every integer $k>y/(-c(y))$ we would get $y+kc(y)<0$, a contradiction. Hence

$$\text{(4)}\qquad c(y)\ge 0\qquad\text{for all }y>0 .$$

Combining (2) with (3) we record, for all $y>0$ and all integers $k\ge0$,

$$\text{(2')}\qquad c\bigl(y+k\,c(y)\bigr)=c\bigl(f^{(k)}(y)\bigr)=c(y).$$

### 3. A two-point inequality

**Lemma 1.** *For all $x,y>0$,*

$$\text{(5)}\qquad \bigl(x-f(y)\bigr)^{2}\;\ge\;2\,\bigl|c(x)-c(y)\bigr|\,\bigl(x+f(y)\bigr)
\;-\;\bigl(c(x)-c(y)\bigr)^{2}.$$

*Proof.* Fix $x,y>0$ and abbreviate
$$s:=c(x)\ge0,\qquad t:=c(y)\ge0,\qquad \delta:=s-t,\qquad W:=f(y)=y+t>0 .$$
Then $f(x)=x+s$, and $f(x)+y=x+s+y=x+W+\delta$ because $y=W-t$.

* *Inequality (A)* reads $(x+W+\delta)^{2}\le 2x^{2}+2W^{2}$. Expanding,
  $$2x^{2}+2W^{2}-(x+W+\delta)^{2}
  =\bigl(x^{2}-2xW+W^{2}\bigr)-2\delta(x+W)-\delta^{2}
  =\bigl(x-W\bigr)^{2}-2\delta(x+W)-\delta^{2},$$
  so (A) is equivalent to
  $$\text{(i)}\qquad \bigl(x-W\bigr)^{2}\ \ge\ 2\delta\,(x+W)+\delta^{2}.$$
* *Inequality (B)* reads $(x+W+\delta)^{2}\ge 4xW$. Expanding,
  $$(x+W+\delta)^{2}-4xW=\bigl(x^{2}-2xW+W^{2}\bigr)+2\delta(x+W)+\delta^{2}
  =\bigl(x-W\bigr)^{2}+2\delta(x+W)+\delta^{2},$$
  so (B) is equivalent to
  $$\text{(ii)}\qquad \bigl(x-W\bigr)^{2}\ \ge\ -2\delta\,(x+W)-\delta^{2}.$$

Writing $Q:=2\delta(x+W)+\delta^{2}$, the two conclusions (i) and (ii) say
$(x-W)^{2}\ge Q$ and $(x-W)^{2}\ge -Q$, hence $(x-W)^{2}\ge|Q|$. Since
$|Q|\ \ge\ |2\delta(x+W)|-|\delta^{2}|=2|\delta|\,(x+W)-\delta^{2}$ (reverse triangle inequality,
and $x+W>0$), we obtain $(x-W)^{2}\ge 2|\delta|(x+W)-\delta^{2}$. Finally $W=f(y)$ and
$\delta=c(x)-c(y)$, which is (5). $\square$

**Remark.** The remainder of the proof uses the original hypothesis only through the identities
(1)–(4) and through (5); the one further place where (A) or (B) is invoked directly is the
derivation of (6) in §4.2 from (B).

### 4. The displacement function is constant

Assume, for contradiction, that $c$ is not constant. By (4) every value of $c$ lies in
$[0,\infty)$, and $c$ attains at least two distinct values.

* **Case A:** there exist $x,y>0$ with $c(x)=s>t=c(y)>0$ (two distinct positive values).
* **Case B:** no such pair exists. Then at most one positive value is attained by $c$, so the set of
  attained values is contained in $\{0,s\}$ for some $s>0$; as at least two distinct values are
  attained, that set equals exactly $\{0,s\}$, and both $0$ and $s$ are attained.

We show that each case is impossible.

#### 4.1 Case A cannot occur

Suppose $c(x)=s>t=c(y)>0$ for some $x,y>0$. Set

$$\delta:=s-t>0,\qquad C:=\bigl|x-y-t\bigr|+t\ \ (\text{independent of }k,m).$$

**The family $(\ast)$.** Fix integers $k,m\ge0$. By (3), $f^{(k)}(x)=x+ks$ and $f^{(m)}(y)=y+mt$,
so by (2'), $c\bigl(f^{(k)}(x)\bigr)=s$ and $c\bigl(f^{(m)}(y)\bigr)=t$, and by (3) again,
$f\bigl(f^{(m)}(y)\bigr)=f^{(m+1)}(y)=y+(m+1)t$. Applying (5) with $x':=f^{(k)}(x)$ and
$y':=f^{(m)}(y)$ (both positive) therefore gives, for all integers $k,m\ge0$,

$$\text{$(\ast)$}\qquad
\Bigl(x+ks-y-(m+1)t\Bigr)^{2}\ \ge\ 2\delta\Bigl(x+ks+y+(m+1)t\Bigr)-\delta^{2}.$$

**Existence of admissible pairs.** Since $t>0$: for every integer $k\ge1$, choose an integer $m$
nearest to $ks/t$, so that $\bigl|ks/t-m\bigr|\le 1/2$. As $ks/t\ge0$, we may and do take $m\ge0$.
Then

$$|ks-mt|\;=\;t\,\Bigl|\frac{ks}{t}-m\Bigr|\;\le\;\frac t2\;\le\;t .$$

Thus admissible pairs — integers $k\ge1$, $m\ge0$ with $|ks-mt|\le t$ — exist with $k$ arbitrarily
large.

**Contradiction.** Take such a pair with $k$ so large that

$$2\delta\bigl(x+y+t+ks\bigr)-\delta^{2}\;>\;C^{2};$$

this is possible because $\delta>0$, while $x,y,t,s$ are fixed, so the left-hand side tends to
$+\infty$ as $k\to\infty$. With $m\ge0$ and $t>0$ we have $mt\ge0$, so the right-hand side of
$(\ast)$ satisfies

$$2\delta\bigl(x+ks+y+(m+1)t\bigr)-\delta^{2}
\;\ge\;2\delta\bigl(x+y+t+ks\bigr)-\delta^{2}\;>\;C^{2},$$

whereas the left-hand side of $(\ast)$ is, since $ks-y-(m+1)t=-y-t+(ks-mt)$,

$$\Bigl(x-y-t+(ks-mt)\Bigr)^{2}
\;\le\;\Bigl(|x-y-t|+|ks-mt|\Bigr)^{2}
\;\le\;\Bigl(|x-y-t|+t\Bigr)^{2}\;=\;C^{2},$$

using $|a+b|\le|a|+|b|$ and $|ks-mt|\le t$. So the left-hand side of $(\ast)$ is at most $C^{2}$
while the right-hand side exceeds $C^{2}$, contradicting $(\ast)$. Hence no two distinct positive
values of $c$ can be attained, and Case A is impossible.

#### 4.2 Case B cannot occur

Assume from now on that the set of values of $c$ is exactly $\{0,s\}$ with $s>0$, and put

$$L_0:=\{y>0:\ c(y)=0\},\qquad L_s:=\{y>0:\ c(y)=s\}.$$

Then $L_0$ and $L_s$ are both non-empty and partition $\mathbb R_{>0}$; moreover
$f(y)=y$ for $y\in L_0$ and $f(y)=y+s$ for $y\in L_s$. By (2), if $y\in L_s$ then
$c(f(y))=c(y)=s$, i.e. $f(y)=y+s\in L_s$; that is,

$$\text{(2'')}\qquad L_s+s\subseteq L_s .$$

**(i) An interval avoiding $L_s$.** Let $u\in L_0$ and $v\in L_s$. Then $f(u)=u$ and $f(v)=v+s$, so
(B) with $x=u$, $y=v$ reads $(u+v)^{2}\ge4u(v+s)$. Since
$$(u+v)^{2}-4u(v+s)=u^{2}+2uv+v^{2}-4uv-4us=(v-u)^{2}-4us,$$
this is

$$\text{(6)}\qquad (v-u)^{2}\ \ge\ 4us\qquad\text{for all }u\in L_0,\ v\in L_s .$$

Hence for fixed $u\in L_0$ no point of $L_s$ lies in the open interval
$\bigl(u-2\sqrt{us},\,u+2\sqrt{us}\bigr)$; as $L_0\cup L_s=\mathbb R_{>0}$, every positive point of
that interval lies in $L_0$. In particular

$$\text{(7)}\qquad \text{if }u\in L_0,\ \text{then}\ \bigl(u,\ u+2\sqrt{us}\bigr)\subseteq L_0 .$$

**(ii) $L_0$ contains a final segment $(\boldsymbol{u_0,\infty})$.**
*Claim:* if $u_0\in L_0$, then $(u_0,\infty)\subseteq L_0$.

*Proof.* Let $S:=\{T\ge u_0:\ (u_0,T)\subseteq L_0\}$; this set is non-empty since $u_0\in S$, and
$u_0+2\sqrt{u_0s}\in S$ by (7), so $T:=\sup S$ satisfies $T\ge u_0+2\sqrt{u_0s}>u_0$.

First, $(u_0,T)\subseteq L_0$: indeed, if $u_0<w<T$, then $w$ is not an upper bound of $S$, so there
is $T'\in S$ with $w<T'$, whence $(u_0,w)\subseteq(u_0,T')\subseteq L_0$.

Assume $T<\infty$. The function $h(z):=z+2\sqrt{sz}$ is continuous and strictly increasing on
$(0,\infty)$, being a sum of the continuous increasing functions $z\mapsto z$ and
$z\mapsto2\sqrt{sz}$. Since $T\in(0,\infty)$ and $h(T)=T+2\sqrt{sT}>T$ (as $s>0$, $T>0$), continuity
at $T$ gives an $\varepsilon>0$ with $h(z)>T$ for every $z\in(T-\varepsilon,T)$. Choose such a $z$
with $z>u_0$ as well, i.e. $z\in\bigl(\max(u_0,T-\varepsilon),\,T\bigr)$, which is a non-empty
interval contained in $(u_0,T)\subseteq L_0$. Then $(u_0,z)\subseteq L_0$ and, by (7) applied to
$z\in L_0$, also $\bigl(z,\,h(z)\bigr)\subseteq L_0$ and $z\in L_0$; consequently
$(u_0,h(z))\subseteq L_0$, i.e. $h(z)\in S$. But $h(z)>T$, contradicting $T=\sup S$. Hence
$T=\infty$, that is $S$ is unbounded above, and therefore $(u_0,\infty)\subseteq L_0$. $\square$

**(iii) Final contradiction.** Fix $u_0\in L_0$; by (ii), $(u_0,\infty)\subseteq L_0$. Fix also
$v_0\in L_s$. By (2''), $v_0+ks\in L_s$ for every integer $k\ge0$ (induction on $k$), so $L_s$ is
unbounded.

Now let $v\in L_s$ and $u\in L_0$. Expanding, (6) is equivalent to

$$u^{2}-2(v+2s)\,u+v^{2}\;\ge\;0\qquad\text{for all }u\in L_0,\ v\in L_s ,$$

since $(v-u)^{2}-4us=u^{2}-2u(v+2s)+v^{2}$. For fixed $v\in L_s$, the polynomial
$u\mapsto u^{2}-2(v+2s)u+v^{2}$ has leading coefficient $1>0$ and discriminant

$$4(v+2s)^{2}-4v^{2}=4\bigl((v+2s)^{2}-v^{2}\bigr)=16s(v+s)>0,$$

so it has the two real roots $v+2s\pm2\sqrt{s(v+s)}$ (indeed
$(v+2s)^{2}-v^{2}=4vs+4s^{2}=4s(v+s)$), the open interval between them is exactly the set where the
polynomial is negative, and therefore

$$\text{(8)}\qquad
J_v:=\Bigl(v+2s-2\sqrt{s(v+s)},\ v+2s+2\sqrt{s(v+s)}\Bigr)\ \text{contains no point of }L_0 .$$

Moreover $J_v$ is non-empty, its length being $4\sqrt{s(v+s)}>0$ (as $s>0$, $v>0$). Finally, writing
$\sqrt{s(v+s)}=v\sqrt{s/v+s^{2}/v^{2}}$ for $v>0$,

$$v+2s-2\sqrt{s(v+s)}=v\Bigl(1-2\sqrt{\tfrac{s}{v}+\tfrac{s^{2}}{v^{2}}}\Bigr)+2s\ \longrightarrow\ +\infty
\qquad\text{as }v\to+\infty,$$

because $\sqrt{s/v+s^{2}/v^{2}}\to0$. Since $L_s$ is unbounded, choose $v\in L_s$ with
$v+2s-2\sqrt{s(v+s)}>u_0$; then $J_v\subseteq(u_0,\infty)\subseteq L_0$, so that
$J_v=J_v\cap L_0=\emptyset$, contradicting (8) and $J_v\ne\emptyset$.

Hence Case B is impossible as well. Both cases being impossible, $c$ is constant:

$$\text{(9)}\qquad\text{there is a constant }c\ge0\text{ with }f(x)=x+c\text{ for every }x>0 .$$

**Remark on regularity.** No regularity of $f$ is assumed or used: $f$ is an arbitrary function
$\mathbb R_{>0}\to\mathbb R_{>0}$, and neither continuity, nor monotonicity, nor injectivity of $f$
is invoked anywhere. In particular the variables $x,y$ are never taken to $0$ or to $\infty$; the
limits appearing above are limits along the integer parameters $k,m$ of the constructed families of
substitutions, and the single limit of a real variable is $z\to T^{-}$ in (ii), where only the
elementary continuity and monotonicity of the explicit function $z\mapsto z+2\sqrt{sz}$ on
$(0,\infty)$ is used.

### 5. Verification that the listed functions work

Let $c\ge0$ be a constant and let $f(x):=x+c$ for $x>0$. Then $f(x)=x+c>0$, so
$f$ maps $\mathbb R_{>0}$ into $\mathbb R_{>0}$. For arbitrary $x,y>0$,

$$(x+y+c)^{2}=x^{2}+y^{2}+c^{2}+2xy+2xc+2yc,$$
$$2x^{2}+2(y+c)^{2}=2x^{2}+2y^{2}+2c^{2}+4yc,$$

hence

$$\bigl(f(x)+y\bigr)^{2}-2\bigl(x^{2}+f(y)^{2}\bigr)=(x+y+c)^{2}-2x^{2}-2(y+c)^{2}
=-(x-y-c)^{2}\le 0,$$

which is (A). Likewise

$$\bigl(f(x)+y\bigr)^{2}-4x\,f(y)=(x+y+c)^{2}-4x(y+c)
=(x-y-c)^{2}\ge 0,$$

which is (B). Thus (A) and (B) hold for all $x,y>0$, and by Lemma 0 the two required inequalities
hold for all $x,y>0$. So every function $f(x)=x+c$ with $c\ge0$ is a solution.

### 6. Conclusion

Suppose $f:\mathbb R_{>0}\to\mathbb R_{>0}$ satisfies the required chain for all $x,y>0$. By
Lemma 0, (A) and (B) hold for all $x,y>0$. Steps 1–2 then give $f(f(y))=2f(y)-y$ for all $y>0$ and
$c(y)=f(y)-y\ge0$ for all $y>0$; Step 4 shows that $c$ is constant, say $c\ge0$. Hence
$f(x)=x+c$ for every $x>0$. Conversely, by Step 5 every such function is a solution. Therefore

$$\boxed{\ f(x)=x+c\quad\text{for every }x>0,\qquad\text{where }c\ge 0\ \text{is a constant.}\ }$$

$\blacksquare$
