//go:build ignore

// generate.go writes the sample images the dev seeders store as media
// (sample-image-1.jpg … sample-image-12.jpg). They are generated rather than
// downloaded so seeding works offline and in CI, and so their license is
// simple (see README.md). The output is deterministic: rerunning it rewrites
// the same files.
//
//	go run ./devModeUtil/sampleimages/generate.go
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
)

const (
	width   = 800
	height  = 600
	count   = 12
	quality = 80
)

// palettes holds a background gradient (first two colors) and an accent
// color per image.
var palettes = [count][3]color.RGBA{
	{{0x1e, 0x3a, 0x8a, 255}, {0x06, 0xb6, 0xd4, 255}, {0xfd, 0xe6, 0x8a, 255}},
	{{0x7c, 0x2d, 0x12, 255}, {0xf9, 0x73, 0x16, 255}, {0xfe, 0xf3, 0xc7, 255}},
	{{0x14, 0x53, 0x2d, 255}, {0x84, 0xcc, 0x16, 255}, {0xec, 0xfc, 0xcb, 255}},
	{{0x4c, 0x1d, 0x95, 255}, {0xec, 0x48, 0x99, 255}, {0xfb, 0xcf, 0xe8, 255}},
	{{0x0f, 0x17, 0x2a, 255}, {0x33, 0x41, 0x55, 255}, {0x38, 0xbd, 0xf8, 255}},
	{{0x88, 0x13, 0x37, 255}, {0xf4, 0x3f, 0x5e, 255}, {0xff, 0xe4, 0xe6, 255}},
	{{0x13, 0x4e, 0x4a, 255}, {0x2d, 0xd4, 0xbf, 255}, {0xf0, 0xfd, 0xfa, 255}},
	{{0x71, 0x3f, 0x12, 255}, {0xea, 0xb3, 0x08, 255}, {0x1c, 0x19, 0x17, 255}},
	{{0x1e, 0x1b, 0x4b, 255}, {0x63, 0x66, 0xf1, 255}, {0xa5, 0xf3, 0xfc, 255}},
	{{0x36, 0x53, 0x14, 255}, {0xfa, 0xcc, 0x15, 255}, {0xff, 0xff, 0xff, 255}},
	{{0x58, 0x1c, 0x87, 255}, {0x0e, 0xa5, 0xe9, 255}, {0xfd, 0xba, 0x74, 255}},
	{{0x27, 0x27, 0x2a, 255}, {0xa1, 0xa1, 0xaa, 255}, {0xef, 0x44, 0x44, 255}},
}

type circle struct {
	x, y, r float64
	alpha   float64
	c       color.RGBA
}

func main() {
	dir := filepath.Join("devModeUtil", "sampleimages")
	for i := range count {
		img := render(i)
		path := filepath.Join(dir, fmt.Sprintf("sample-image-%d.jpg", i+1))
		f, err := os.Create(path)
		if err != nil {
			log.Fatal(err)
		}
		if err := jpeg.Encode(f, img, &jpeg.Options{Quality: quality}); err != nil {
			log.Fatal(err)
		}
		if err := f.Close(); err != nil {
			log.Fatal(err)
		}
	}
}

// render draws a diagonal gradient with a few soft, translucent circles.
func render(i int) *image.RGBA {
	p := palettes[i]
	rng := rand.New(rand.NewSource(int64(i + 1)))
	angle := rng.Float64() * math.Pi
	dx, dy := math.Cos(angle), math.Sin(angle)

	var circles []circle
	for range 3 + rng.Intn(4) {
		accent := p[2]
		if rng.Intn(3) == 0 {
			accent = p[0]
		}
		circles = append(circles, circle{
			x:     rng.Float64() * width,
			y:     rng.Float64() * height,
			r:     60 + rng.Float64()*220,
			alpha: 0.25 + rng.Float64()*0.45,
			c:     accent,
		})
	}

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	maxProj := math.Abs(dx)*width + math.Abs(dy)*height
	for y := range height {
		for x := range width {
			proj := (float64(x)*math.Abs(dx) + float64(y)*math.Abs(dy)) / maxProj
			r, g, b := lerp(p[0], p[1], proj)
			for _, c := range circles {
				d := math.Hypot(float64(x)-c.x, float64(y)-c.y)
				// Soft edge over the outer 15% of the radius.
				cover := clamp((c.r-d)/(c.r*0.15), 0, 1) * c.alpha
				r = r*(1-cover) + float64(c.c.R)*cover
				g = g*(1-cover) + float64(c.c.G)*cover
				b = b*(1-cover) + float64(c.c.B)*cover
			}
			img.SetRGBA(x, y, color.RGBA{uint8(r), uint8(g), uint8(b), 255})
		}
	}
	return img
}

func lerp(a, b color.RGBA, t float64) (float64, float64, float64) {
	return float64(a.R) + (float64(b.R)-float64(a.R))*t,
		float64(a.G) + (float64(b.G)-float64(a.G))*t,
		float64(a.B) + (float64(b.B)-float64(a.B))*t
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
