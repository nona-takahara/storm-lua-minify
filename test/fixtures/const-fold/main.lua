-- 定数の事前計算と定数伝搬(#44)の効果を確認するfixture。
-- 畳み込み・伝搬が効くコードと、安全のため見送るべきコードの両方を含む。

-- 畳み込まれる算術・比較・連結
local sum = 1 + 2
local quotient = 7 // 2
local ratio = 3 / 1
local greeting = "Hello, " .. "world!"
print(sum, quotient, ratio, greeting)

-- 伝搬される定数(参照が1箇所だけの宣言)
local width = 10
local height = 20
local area = width * height
print(area)

-- 1文字リテラルは参照が複数でも伝搬される
local one = 1
print(one, one, one)

-- 見送る: 副作用のある呼び出しを含む式は定数にならないので畳み込まない
local withCall = 1 + sideEffect()
print(withCall)

-- 見送る: 再代入されるローカルは伝搬しない
local counter = 5
counter = counter + 1
print(counter)

-- 見送る: 保持アノテーションの付いた宣言は伝搬しない
--@storm keep
local reserved = 42
print(reserved)

-- メソッド呼び出しの基底に定数が来る場合。Luaの文法では定数をそのまま基底に
-- 置けないので、出力側が丸括弧を補う。
local label = "a" .. "b"
print(label:upper())

-- 負の定数も、ほかの定数と同じように配られる。
local offset = -5
print(offset)

-- 文字列の長さと大小比較も、その場で決まる。
print(#"abcd", "a" < "b")
