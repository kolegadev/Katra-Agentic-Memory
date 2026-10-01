# IMO 2026 — Problem 2

## Problem

Let $ABC$ be a triangle and let $M$ and $N$ be the midpoints of sides $AB$ and $AC$ respectively.
Points $K$ and $L$ are chosen strictly inside triangles $BMC$ and $BNC$ respectively, such that
$K$ lies strictly inside triangle $ABL$ and $L$ lies strictly inside triangle $AKC$. Suppose that
$$\angle KBA=\angle ACL,\qquad \angle LBK=\angle LNC,\qquad \angle LCK=\angle BMK .$$
Let $O$ be the circumcentre of triangle $AKL$. Prove that $OM=ON$.

## Solution

### The figure

Fix a triangle $ABC$ with midpoints $M$ of $AB$ and $N$ of $AC$. The hypotheses place $K$ strictly
inside the triangle $BMC$ and strictly inside the triangle $ABL$, and $L$ strictly inside the
triangle $BNC$ and strictly inside the triangle $AKC$; finally the three angles are equal in pairs:
$\angle KBA$ and $\angle ACL$, then $\angle KBL$ and $\angle LNC$, then $\angle LCK$ and
$\angle BMK$. The claim is that the circumcentre $O$ of triangle $AKL$ is equidistant from the two
midpoints $M$ and $N$.

The first thing the proof does (Lemma 1) is to record that the interiority hypotheses completely
determine how the rays at $A$, $B$ and $C$ are interleaved: read counterclockwise from $A$, the rays
occur as $AB,AK,AL,AC$; read clockwise from $B$, they occur as $BA,BK,BL,BC$; read counterclockwise
from $C$, they occur as $CA,CL,CK,CB$. Thus the figure consists of a triangle $ABC$ with its two
midpoints, two points $K,L$ inside the angle $\angle BAC$ arranged in this order, and the three
stated angle equalities; the point $O$ is the centre of the circle through $A,K,L$.

### Notation and normalisation

All hypotheses are invariant under similarities of the plane, and so is the conclusion, so we may
place
$$A=0,\qquad B=c\ (\text{real},\ c>0),\qquad C=b\,e^{i\alpha},$$
where $b=|AC|>0$ and $\alpha=\angle BAC\in(0,\pi)$; we identify the plane with $\mathbb C$. Then
$$M=\tfrac c2,\qquad N=\tfrac b2 e^{i\alpha}.$$
Write $\beta=\angle ABC$, $\gamma=\angle ACB$ (so $\alpha+\beta+\gamma=\pi$), and
$$x:=\angle ABK=\angle ACL,\qquad y:=\angle KBL=\angle LNC,\qquad z:=\angle LCK=\angle BMK$$
for the three common values appearing in the hypotheses. Finally put
$$c_a:=\cos\alpha,\qquad s_a:=\sin\alpha .$$

Throughout, "directed angle" means an angle in the fixed (counterclockwise) orientation of the
plane, and for vectors $u,v\ne 0$ we use the identity
$$\cot\angle(u\to v)=\frac{\operatorname{Re}\bigl(v\,\overline u\bigr)}{\operatorname{Im}\bigl(v\,\overline u\bigr)} ,$$
which is the cotangent of $\arg(v/u)$ (it is well defined iff $\arg(v/u)\not\equiv 0\pmod\pi$).

---

## 1. The shape of the configuration

**Lemma 1.** (a) $K$ and $L$ lie strictly inside the angle $\angle BAC$; moreover the rays
$AB,AK,AL,AC$ occur in this counterclockwise order from $A$.
(b) At $B$ the rays $BA,BK,BL,BC$ occur in this (clockwise) order, i.e. (in counterclockwise
order) $BC,BL,BK,BA$.
(c) At $C$ the rays $CA,CL,CK,CB$ occur in this counterclockwise order.
(d) $0<x<\beta$ and $0<x<\gamma$; consequently $x\neq\beta$ and $x\neq\gamma$.
(e) $\angle ABL=x+y$ and $\angle ACK=x+z$.

**Proof.** (i) $K$ lies strictly inside triangle $BMC$. The vertices $B,M$ of that triangle lie on
the line $AB$ and its vertex $C$ lies strictly on the $C$-side of $AB$; hence the whole triangle
$BMC$ (except its side $BM\subset AB$) lies strictly on the $C$-side of $AB$, and $K$ does too.
The angle of $BMC$ at $B$ is $\angle MBC=\angle ABC$, so $BK$ lies strictly between $BA$ and $BC$;
in particular $0<x<\beta$.  Similarly, $L$ lies strictly inside triangle $BNC$: its vertices
$N,C$ lie on the line $AC$, its vertex $B$ lies strictly on the $B$-side of $AC$, so $L$ lies on
that side, and the angle of $BNC$ at $C$ is $\angle NCB=\angle ACB$, so $CL$ lies strictly between
$CA$ and $CB$; hence $0<x<\gamma$.

(ii) $L$ lies strictly inside triangle $AKC$, whose vertices $A$ and $C$ lie on the line $AC$ and
whose vertex $K$ lies strictly on the $B$-side of $AC$ (by (i)); hence $L$ lies on the $B$-side of
$AC$ and, because $L$ is an interior point, $AL$ lies strictly inside the angle $\angle KAC$, i.e.
$AL$ lies strictly between $AK$ and $AC$.
Also $L$ lies inside the angle $\angle ACB$ (shown above) and inside triangle $BNC$, so it lies on
the $A$-side of $BC$ and on the $C$-side of $AB$; hence $L$ lies strictly inside the angle
$\angle ABC$, i.e. $BL$ lies strictly between $BA$ and $BC$.

(iii) $K$ lies strictly inside triangle $ABL$; in particular $K$ lies inside the angle $\angle ABL$
of that triangle, so $AK$ lies strictly inside $\angle BAL$, i.e. $AK$ is strictly between $AB$ and
$AL$, and $BK$ is strictly between $BA$ and $BL$.
Moreover $K$ lies inside the angle $\angle ACB$: indeed $K$ lies on the $A$-side of $BC$ (from (i))
and on the $B$-side of $AC$ (it lies inside triangle $ABL$, and $A,B,L$ all lie in the closed
$B$-side half-plane of $AC$ by (i)–(ii)). Hence $CK$ lies strictly between $CA$ and $CB$.

(iv) Collecting: at $A$ the order is $AB,AK,AL,AC$; at $B$ the order $BA,BK,BL,BC$; at $C$ the
order $CA,CL,CK,CB$. For the last of these, note first that $CL$ and $CK$ each lie strictly between
$CA$ and $CB$: for $CK$ this was shown in (iii); for $CL$ it follows because $L$ lies strictly
inside triangle $AKC$, so the ray $CL$ lies strictly inside the angle $\angle ACK$ of that triangle,
and $CK$ itself lies strictly inside $\angle ACB$. Thus $CL$ lies strictly between $CA$ and $CK$
(an interior point of a triangle subtends each side strictly inside the corresponding vertex
angle), and both rays $CL,CK$ lie in the open angular cone $(CA,CB)$, whose span is
$\gamma<\pi$. In such a cone the angular order is unambiguous, so the order at $C$ is
$CA,CL,CK,CB$. In particular
$$\angle ABL=\angle ABK+\angle KBL=x+y,\qquad \angle ACK=\angle ACL+\angle LCK=x+z . \qquad\square$$

---

## 2. Parametrisation of $K$ and $L$

Put
$$p:=\cot x,\qquad q:=\cot\angle BAK,\qquad q':=\cot\angle CAL .$$
By Lemma 1 the angles $\angle BAK,\angle CAL$ lie in $(0,\alpha)\subset(0,\pi)$, and $x\in(0,\pi)$.

**Lemma 2.** $K=\dfrac{c\,(q+i)}{p+q}$ and $L=\dfrac{b\,e^{i\alpha}(q'-i)}{p+q'}$.

**Proof.** Write $K=u+iv$ with $v>0$ (Lemma 1(i): $K$ is on the $C$-side of $AB$). Since
$A=0$ and $B=c$, $\angle BAK$ is the angle at the origin between the positive real axis and
$AK=u+iv$, so $\cot\angle BAK=u/v=q$, i.e. $u=qv$. The vector $BA$ points in the direction
$-1$ and the vector $BK=(u-c)+iv$ lies strictly inside the angle $\angle ABC$; therefore the
interior angle at $B$ satisfies $\cot\angle ABK=(c-u)/v=p$, i.e. $c-u=pv$. Adding the two
relations gives $v(p+q)=c$, whence
$$K=\frac{qc+ic}{p+q}=\frac{c(q+i)}{p+q},$$
as claimed (note $p+q=c/v>0$).

For $L$, rotate the picture by $-\alpha$, i.e. work in the orthonormal frame whose positive axis
is the ray $AC$. In that frame $C$ has coordinates $(b,0)$ and $L$ has coordinates $(X,Y)$, and
because $L$ lies on the $B$-side of the line $AC$ we have $Y<0$. The angle $\angle CAL$ is the
angle between the positive axis and $AL$, and since $Y<0$,
$\cot\angle CAL=X/(-Y)=q'$; the angle $\angle ACL$ is the angle at $C$ between $CA$ (direction
$-1$) and $CL=(X-b,Y)$ with $Y<0$, so $\cot\angle ACL=(b-X)/(-Y)=p$. Adding gives
$-Y(p+q')=b$, i.e. $Y=-b/(p+q')$ and $X=q'b/(p+q')$. Rotating back,
$$L=e^{i\alpha}\bigl(X+iY\bigr)=\frac{b\,e^{i\alpha}(q'-i)}{p+q'}. \qquad\square$$

---

## 3. The two midpoint conditions in coordinates

Throughout this section and the next, all algebraic identities are meant in the ring
$$\mathbb Q[p,q,q',b,c,c_a,s_a]\big/\langle c_a^2+s_a^2-1\rangle ,$$
i.e. we use $\cos^2\alpha+\sin^2\alpha=1$ freely (and, equivalently, $\overline{e^{i\alpha}}=e^{-i\alpha}$).

**Lemma 3 (median formula).** $\cot\angle BMK=\dfrac{q-p}{2}$ and
$\cot\angle LNC=\dfrac{q'-p}{2}$.

**Proof.** By Lemma 2, $MK=K-M=\dfrac{c(q+i)}{p+q}-\dfrac c2=\dfrac{c\bigl((q-p)+2i\bigr)}{2(p+q)}$,
while $MB=\frac c2$ is real and positive. Therefore
$$\cot\angle(MB\to MK)=\frac{\operatorname{Re}\bigl(MK\,\overline{MB}\bigr)}
{\operatorname{Im}\bigl(MK\,\overline{MB}\bigr)}
=\frac{c^2(q-p)/(4(p+q))}{c^2/(2(p+q))}=\frac{q-p}{2}.$$
By Lemma 1(b), $MK$ points into the upper half-plane whereas $MB$ points along the positive real
axis, so this directed angle is exactly the interior angle $\angle BMK$.

For the second formula rotate by $-\alpha$ (this does not change (co)tangents of directed angles).
In the rotated frame $A=0$, $C=b$, $L=X+iY$ with $X=q'b/(p+q')$, $Y=-b/(p+q')$ (Lemma 2), and
$N=b/2$. Thus $NL=\frac{b(q'-p)}{2(p+q')}-i\frac{b}{p+q'}$ and $NC=b/2$ is real and positive, so
$$\cot\angle(NC\to NL)=-\frac{q'-p}{2}.$$
Here $NL$ points into the *lower* half-plane, so the directed angle from $NC$ to $NL$ lies in
$(-\pi,0)$ and the interior angle $\angle LNC$ is its absolute value; hence
$\cot\angle LNC=-\cot\angle(NC\to NL)=\frac{q'-p}{2}$. $\square$

**Proposition 4.** The hypothesis $\angle LCK=\angle BMK$ is equivalent to
$$\boxed{\ E_3=0\ }\qquad\text{where}\qquad
E_3:=b(p+q)^2-c\bigl[c_a(p^2+q^2+2)-s_a(p-q)(pq-1)\bigr],$$
and the hypothesis $\angle KBL=\angle LNC$ is equivalent to
$$\boxed{\ E_2=0\ }\qquad\text{where}\qquad
E_2:=b\bigl[c_a(p^2+q'^2+2)-s_a(p-q')(pq'-1)\bigr]-c(p+q')^2 .$$

**Proof.** (a) *The first equation.* By Lemma 1(c) the directed angle from $CL$ to $CK$ equals the
interior angle $\angle LCK$, and by Lemma 3 and Lemma 1(b) the interior angle $\angle BMK$ has
cotangent $\frac{q-p}{2}$; as $\cot$ is injective on $(0,\pi)$ the hypothesis is therefore
equivalent to $\cot\angle(CL\to CK)=\frac{q-p}{2}$.

By Lemma 2,
$$CL=L-C=-\frac{b\,e^{i\alpha}(p+i)}{p+q'},\qquad CK=K-C=\frac{c(q+i)}{p+q}-b\,e^{i\alpha}.$$
Hence
$$CK\,\overline{CL}=-\frac{bc\,e^{-i\alpha}\bigl((pq+1)+i(p-q)\bigr)}{(p+q)(p+q')}
+\frac{b^2(p-i)}{p+q'},$$
because $(q+i)(p-i)=(pq+1)+i(p-q)$ and $\overline{e^{i\alpha}}=e^{-i\alpha}$. Multiplying by
$\frac{(p+q)(p+q')}{b}$ and setting $Z:=\frac{(p+q)(p+q')}{b}\,CK\,\overline{CL}$ gives
$$Z=-c\,e^{-i\alpha}\bigl((pq+1)+i(p-q)\bigr)+b\,(p-i)(p+q),$$
so, using $e^{-i\alpha}=c_a-is_a$,
$$\operatorname{Re}Z=bp(p+q)-c\bigl[c_a(pq+1)+s_a(p-q)\bigr],\qquad
\operatorname{Im}Z=-b(p+q)+c\bigl[c_a(q-p)+s_a(pq+1)\bigr].$$
The equation $\cot\angle(CL\to CK)=\frac{q-p}{2}$ says $2\operatorname{Re}Z=(q-p)\operatorname{Im}Z$
(the factor $\frac{(p+q)(p+q')}{b}$ is a positive real number). Expanding,
$$2bp(p+q)-b(p^2-q^2)-2c\,c_a(pq+1)-c\,c_a(q-p)^2-2c\,s_a(p-q)-c\,s_a(q-p)(pq+1)=0 .$$
Now $2bp(p+q)-b(p^2-q^2)=b(p+q)^2$, and
$$-2c\,c_a(pq+1)-c\,c_a(q-p)^2=-c\,c_a\,(p^2+q^2+2),\qquad
-2c\,s_a(p-q)-c\,s_a(q-p)(pq+1)=c\,s_a(p-q)(pq-1),$$
so the equation becomes exactly $E_3=0$. (The denominator $\operatorname{Im}Z$ is non-zero because
$0<\angle LCK<\pi$; see Lemma 1(c).)

(b) *The second equation.* By Lemma 1(b) the directed angle from $BL$ to $BK$ equals the interior
angle $\angle KBL$, and by Lemma 3 this hypothesis is equivalent to
$\cot\angle(BL\to BK)=\frac{q'-p}{2}$. Now
$$BL=L-B=\frac{b\,e^{i\alpha}(q'-i)}{p+q'}-c,\qquad BK=K-B=-\frac{c(p-i)}{p+q},$$
so, with $(p-i)(q'+i)=(pq'+1)+i(p-q')$,
$$BK\,\overline{BL}=-\frac{bc\,e^{-i\alpha}\bigl((pq'+1)+i(p-q')\bigr)}{(p+q)(p+q')}
+\frac{c^2(p-i)}{p+q}.$$
Multiplying by $\frac{(p+q)(p+q')}{c}$ and setting $Z':=\frac{(p+q)(p+q')}{c}BK\,\overline{BL}$,
$$Z'=-b\,e^{-i\alpha}\bigl((pq'+1)+i(p-q')\bigr)+c\,(p-i)(p+q'),$$
hence
$$\operatorname{Re}Z'=cp(p+q')-b\bigl[c_a(pq'+1)+s_a(p-q')\bigr],\qquad
\operatorname{Im}Z'=-c(p+q')+b\bigl[c_a(q'-p)+s_a(pq'+1)\bigr].$$
The equation $2\operatorname{Re}Z'=(q'-p)\operatorname{Im}Z'$ (the factor
$\frac{(p+q)(p+q')}{c}$ is again a positive real number) becomes, after the same expansion as
in (a) (with $(b,c,p,q,p+q)$ replaced by $(c,b,p,q',p+q')$),
$$c(p+q')^2-b\bigl[c_a(p^2+q'^2+2)-s_a(p-q')(pq'-1)\bigr]=0,$$
i.e. $E_2=0$. (Again $\operatorname{Im}Z'\ne0$ since $0<\angle KBL<\pi$.) $\square$

**Remark.** $E_2$ and $E_3$ are interchanged by the substitution
$(b,c,q,q')\mapsto(-c,-b,q',q)$, which reflects the symmetry of the problem in $B\leftrightarrow C$;
this is why the two computations are the same.

---

## 4. The conclusion in coordinates

**Proposition 5.** With
$$U:=q'\,c\,s_a+b-c\,c_a,\qquad V:=b\,c_a-c-q\,b\,s_a,\qquad S:=(q+q')c_a-(qq'-1)s_a,$$
$$F_0:=2c(q^2+1)(p+q')U+2b(q'^2+1)(p+q)V-(b^2-c^2)(p+q)(p+q')S,$$
the assertion $OM=ON$ is equivalent to $F_0=0$.

**Proof.** *(Step 1: the distance condition is a linear equation for $O$.)*
Since $M=\frac B2$ and $N=\frac C2$,
$$OM^2-ON^2=\Bigl|O-\tfrac B2\Bigr|^2-\Bigl|O-\tfrac C2\Bigr|^2
=\tfrac14\bigl(|B|^2-|C|^2\bigr)-O\cdot(B-C),$$
so $OM=ON\iff 4O\cdot(C-B)=|C|^2-|B|^2$. Since $O$ is the circumcentre of $A=0,K,L$, we have
$2O\cdot K=|K|^2$ and $2O\cdot L=|L|^2$. The three linear conditions
$$2O\cdot K=|K|^2,\qquad 2O\cdot L=|L|^2,\qquad 4O\cdot(C-B)=|C|^2-|B|^2$$
have a solution $O\in\mathbb R^2$ if and only if the three vectors
$(K,|K|^2)$, $(L,|L|^2)$, $\bigl(C-B,\tfrac12(|C|^2-|B|^2)\bigr)$ in $\mathbb R^3$ are linearly
dependent, i.e. if and only if
$$\Delta':=\det\begin{pmatrix}K_x&K_y&|K|^2\\ L_x&L_y&|L|^2\\
C_x-B_x&C_y-B_y&\frac12(|C|^2-|B|^2)\end{pmatrix}=0 .$$
Indeed the first two conditions determine $O$ uniquely (as the circumcentre), since $A,K,L$ are not
collinear: $K\ne L$ because $K$ is an interior point of triangle $ABL$ whereas $L$ is a vertex of
it, and $AK$ lies strictly inside the angle $\angle BAL$ (Lemma 1(a)), so $K$ is not on the line
$AL$. A $3\times 2$ system whose coefficient matrix has rank $2$ is solvable if and only if the
determinant of its augmented $3\times3$ matrix vanishes, which is exactly $\Delta'=0$.

*(Step 2: computing $\Delta'$.)* Write $W=C-B=b\,e^{i\alpha}-c$. Straight from Lemma 2,
$$K=\frac{c(q+i)}{p+q},\quad L=\frac{b\,e^{i\alpha}(q'-i)}{p+q'},\quad
|K|^2=\frac{c^2(q^2+1)}{(p+q)^2},\quad |L|^2=\frac{b^2(q'^2+1)}{(p+q')^2}.$$
Using $[u,v]=u_xv_y-u_yv_x=\operatorname{Im}(\overline u\,v)$ and $\overline{e^{i\alpha}}=e^{-i\alpha}$
(valid since $c_a^2+s_a^2=1$), a direct computation gives
$$[K,L]=\frac{-bc\,S}{(p+q)(p+q')},\qquad [L,W]=\frac{b\,U}{p+q'},\qquad [K,W]=\frac{-c\,V}{p+q},$$
with $U,V,S$ as above. [All three computations are displayed, so that none is left to check by analogy.
Since $\overline K=\frac{c(q-i)}{p+q}$, $\overline L=\frac{b\,e^{-i\alpha}(q'+i)}{p+q'}$ and
$[u,v]=\operatorname{Im}(\overline u\,v)$,
$$\overline K\,L=\frac{bc\,e^{i\alpha}(q-i)(q'-i)}{(p+q)(p+q')},\qquad
\overline L\,W=\frac{b\bigl(b(q'+i)-c\,e^{-i\alpha}(q'+i)\bigr)}{p+q'},\qquad
\overline K\,W=\frac{c\bigl(b\,e^{i\alpha}(q-i)-c(q-i)\bigr)}{p+q}.$$
Writing $e^{i\alpha}=c_a+is_a$ and $e^{-i\alpha}=c_a-is_a$: with
$(q-i)(q'-i)=(qq'-1)-i(q+q')$, whose product with $c_a+is_a$ has imaginary part
$(qq'-1)s_a-(q+q')c_a$, the first line gives
$$[K,L]=\frac{bc\,\bigl[(qq'-1)s_a-(q+q')c_a\bigr]}{(p+q)(p+q')}=\frac{-bc\,S}{(p+q)(p+q')};$$
with $(c_a-is_a)(q'+i)=(c_aq'+s_a)+i(c_a-s_aq')$, the second gives
$$[L,W]=\frac{b\,\bigl[b-c(c_a-s_aq')\bigr]}{p+q'}=\frac{b\,\bigl(q'c\,s_a+b-c\,c_a\bigr)}{p+q'}=\frac{b\,U}{p+q'};$$
and with $(c_a+is_a)(q-i)=(c_aq+s_a)+i(s_aq-c_a)$, the third gives
$$[K,W]=\frac{c\,\bigl[b(s_aq-c_a)+c\bigr]}{p+q}=-\frac{c\,\bigl(b\,c_a-c-q\,b\,s_a\bigr)}{p+q}=\frac{-c\,V}{p+q}.\quad]$$

Expanding the determinant of Step 1 along its last column,
$$\Delta'=w\,[K,L]+|K|^2\,[L,W]-|L|^2\,[K,W],\qquad w:=\tfrac12(b^2-c^2).$$
Multiplying by $(p+q)^2(p+q')^2$ and inserting the three identities above,
$$\Delta'\,(p+q)^2(p+q')^2=-w\,bc\,S\,(p+q)(p+q')+bc^2(q^2+1)U(p+q')+b^2c(q'^2+1)V(p+q)
=\frac{bc}{2}\,F_0 .$$
Since $(p+q)(p+q')\ne0$ (Lemma 2) and $bc>0$, we get $\Delta'=0\iff F_0=0$. $\square$

---

## 5. The algebraic core: the certificate identity

Everything is now reduced to the following completely explicit algebraic statement.

**Proposition 6 (certificate).** In the ring
$\mathbb Q[p,q,q',b,c,c_a,s_a]/\langle c_a^2+s_a^2-1\rangle$ put
$$D_1:=c\,c_a+c\,p\,s_a-b,\qquad D_2:=b\,c_a+b\,p\,s_a-c,$$
$$\begin{aligned}
\text{cof}_0&:= b^2c_a(p+q)-b^2s_a\,q(p+q)-2bc(p+q)+c^2c_a(p+q)+c^2s_a(q^2-pq+2),\\[2pt]
\widehat{cof}&:=-b^3(p+q')+3b^2c\,c_a(p+q')+b^2c\,s_a(p^2-pq'+2)-2bc^2c_a s_a(p^2+1)\\
&\qquad\qquad+2bc^2s_a^2q'(p^2+1)-3bc^2(p+q')+c^3c_a(p+q')+c^3s_a\,p(p+q'),\\[2pt]
\Omega&:=\text{(the explicit polynomial listed in Appendix A)} .
\end{aligned}$$
Then
$$\boxed{\ D_1D_2F_0\;\equiv\;\text{cof}_0\,D_1\,E_2\;-\;\widehat{cof}\,E_3
\pmod{c_a^2+s_a^2-1}\ }$$
that is, the difference of the two sides is a multiple of $c_a^2+s_a^2-1$ in
$\mathbb Q[p,q,q',b,c,c_a,s_a]$ (where $E_2,E_3,F_0$ are as in Propositions 4 and 5). The identity was
obtained by an elimination computation — polynomial reduction of $F_0$ modulo the ideal
$\langle E_2,E_3,c_a^2+s_a^2-1\rangle$, the displayed polynomials being the cofactors that the reduction
produces (an unreduced cofactor appears in Appendix A) — and it is stated here explicitly precisely so
that it can be verified by finite expansion.
Equivalently, there is a polynomial $\Omega$ (given in Appendix A) with the exact identity
$$D_1D_2F_0=\text{cof}_0\,D_1\,E_2-\widehat{cof}\,E_3-bc\,\Omega\,(c_a^2+s_a^2-1),$$
where $\widehat{cof}$ has to be taken in the unreduced form given in Appendix A.

**Proof.** Both statements are identities between explicit polynomials in the seven indeterminates
$p,q,q',b,c,c_a,s_a$; no variable is inverted, so the identities involve no division and hold for
all real values of the variables. The two sides of each identity have total degree at most $13$ in
the seven variables, equivalently at most $10$ in the five variables $p,q,q',b,c$ if the constants
$c_a,s_a$ are assigned degree $0$.
Each identity is verified by expanding both sides as polynomials and comparing them monomial by
monomial; this is a finite computation over $\mathbb Z$, which a reader can either carry out by hand
or by any computer algebra system, and in which the relation $c_a^2+s_a^2=1$ is *not* used in the
exact form. The congruence form follows from the exact form, since it is precisely the exact form
reduced modulo $c_a^2+s_a^2-1$.

The polynomials $\text{cof}_0$ and $\widehat{cof}$ are obtained as the coefficients produced when
$F_0$ is reduced modulo a Gröbner basis of the ideal
$\langle E_2,E_3,c_a^2+s_a^2-1\rangle$ (lexicographic order, $q'\succ q$). The certificate therefore
exhibits $D_1D_2F_0$ as an element of that ideal: on the circle $c_a^2+s_a^2=1$, the point
$(p,q,q',b,c,c_a,s_a)$ of every configuration satisfying $E_2=E_3=0$ also satisfies $D_1D_2F_0=0$.
$\square$

**Proposition 7.** For every configuration satisfying the hypotheses of the problem, $D_1\ne0$ and
$D_2\ne0$.

**Proof.** As $p=\cot x=\cos x/\sin x$, we have
$$D_1\sin x=c\bigl(c_a\sin x+s_a\cos x\bigr)-b\sin x=c\sin(\alpha+x)-b\sin x,$$
$$D_2\sin x=b\sin(\alpha+x)-c\sin x .$$
Since $\sin x>0$ ($0<x<\pi$), $D_1=0$ is equivalent to $c\sin(\alpha+x)=b\sin x$; expanding
$\sin(\alpha+x)$ this is $c\sin\alpha\cos x=(b-c\cos\alpha)\sin x$. Using the projection identities
$c\sin\alpha=a\sin\gamma$ and $b-c\cos\alpha=a\cos\gamma$ (valid in every triangle $ABC$, where
$a=|BC|$; these are the sine rule and the projection identity $b=a\cos\gamma+c\cos\alpha$), this becomes
$$D_1\sin x=a\bigl(\sin\gamma\cos x-\cos\gamma\sin x\bigr)=a\sin(\gamma-x),$$
so $D_1=0\iff\sin(\gamma-x)=0$. Since $x,\gamma\in(0,\pi)$ we have $\gamma-x\in(-\pi,\pi)$, so
$\sin(\gamma-x)=0\iff\gamma=x$. By Lemma 1(d), $x<\gamma$, so $D_1\ne0$. (No division by any
possibly-vanishing quantity is used.) The proof for $D_2$ is identical:
$$D_2\sin x=b\sin(\alpha+x)-c\sin x=b\sin\alpha\cos x-(c-b\cos\alpha)\sin x
=a\bigl(\sin\beta\cos x-\cos\beta\sin x\bigr)=a\sin(\beta-x),$$
using $b\sin\alpha=a\sin\beta$ and $c-b\cos\alpha=a\cos\beta$ (the projection identity
$c=a\cos\beta+b\cos\alpha$); hence $D_2=0\iff x=\beta$, which is
impossible by Lemma 1(d). $\square$

## 6. End of the proof

Let $ABC,M,N,K,L,O$ be as in the problem. By Lemma 1 and Lemma 2 the configuration is described by
$(p,q,q')$ as above. The hypothesis $\angle KBA=\angle ACL$ is built into the definition of $x$ and
into the parametrisation of Lemma 2; by Proposition 4 the other two hypotheses,
$\angle LCK=\angle BMK$ and $\angle KBL=\angle LNC$, give
$$E_3=0\qquad\text{and}\qquad E_2=0 .$$
Trivially $c_a^2+s_a^2-1=0$; hence, by Proposition 6 (congruence form),
$$D_1D_2F_0\equiv \text{cof}_0D_1\cdot 0-\widehat{cof}\cdot 0=0\pmod{c_a^2+s_a^2-1},$$
i.e. $D_1D_2F_0$ is a multiple of $c_a^2+s_a^2-1$; as the latter is $0$, we get $D_1D_2F_0=0$.
By Proposition 7, $D_1D_2\ne0$, so $F_0=0$. By Proposition 5, $OM=ON$. $\blacksquare$

---

## Remarks

**1.** The key point of the configuration is a symmetry: the substitution
$(b,c,q,q')\mapsto(-c,-b,q',q)$ interchanges $E_2$ and $E_3$, as recorded after Proposition 4.
Geometrically it is the reflection $B\leftrightarrow C$ of the triangle (which also swaps $M$ and
$N$); it is the reason why the two second and third angle hypotheses produce equations of the same
shape.

**2.** Nothing in the proof requires the degenerate cases to be excluded by hand: the hypotheses
force $0<x<\beta$ and $0<x<\gamma$ (Lemma 1(d)), which is what makes $D_1,D_2\ne0$ (Proposition 7),
and the parametrisation of Lemma 2 has $p+q=c/v>0$, $p+q'=b/(-Y)>0$, so all divisions performed are
legitimate.

---

## Appendix A: the unreduced $\widehat{cof}$ and $\Omega$ of Proposition 6

For the *exact* form of the identity of Proposition 6 one takes
$$\begin{aligned}
\widehat{cof}_{\text{unred}}=\;&
-b^3c_a^2p-b^3c_a^2q'-b^3p\,s_a^2-b^3q's_a^2
+3b^2c\,c_a p+3b^2c\,c_a q'+b^2c\,p^2s_a-b^2c\,pq's_a+2b^2c\,s_a\\
&-bc^2c_a^2p-bc^2c_a^2q'
-2bc^2c_a p^2s_a-2bc^2c_a s_a
+2bc^2p^2q's_a^2-bc^2p\,s_a^2-2bc^2p+bc^2q's_a^2-2bc^2q'\\
&+c^3c_a p+c^3c_a q'+c^3p^2s_a+c^3pq's_a ,
\end{aligned}$$
and the $\Omega$ of that form is, explicitly,
$$\begin{aligned}
\Omega=\;&2b^2c_a p^2q+2b^2c_a pq q'-2b^2c_a p-2b^2c_a q'+b^2p^4s_a+3b^2p^3q\,s_a+b^2p^3q's_a
+3b^2p^2qq's_a-b^2p^2s_a\\
&+b^2pq\,s_a-b^2pq's_a+b^2qq's_a
-2bc\,p^2q+2bc\,p^2q'-2bc\,q+2bc\,q'\\
&-2c^2c_a p^2q'-2c^2c_a pqq'+2c^2c_a p+2c^2c_a q
-c^2p^4s_a-c^2p^3q\,s_a-3c^2p^3q's_a-3c^2p^2qq's_a\\
&+c^2p^2s_a+c^2pq\,s_a-c^2pq's_a-c^2qq's_a .
\end{aligned}$$

With these two polynomials, the identity
$$D_1D_2F_0=\text{cof}_0\,D_1\,E_2-\widehat{cof}_{\text{unred}}\,E_3-bc\,\Omega\,(c_a^2+s_a^2-1)$$
holds exactly in $\mathbb Q[p,q,q',b,c,c_a,s_a]$; reducing $\widehat{cof}_{\text{unred}}$ modulo
$c_a^2+s_a^2-1$ gives the shorter expression $\widehat{cof}$ displayed in Proposition 6.
