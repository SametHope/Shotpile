param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Size = 1024
)

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-square background with a soft vertical gradient
$radius = [int]($Size * 0.22)
$rect = New-Object System.Drawing.Rectangle 0, 0, ($Size - 1), ($Size - 1)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.CloseFigure()

$top = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
$bottom = [System.Drawing.Color]::FromArgb(255, 29, 78, 216)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 0, $Size), $top, $bottom
$g.FillPath($brush, $path)

# sieve: three bars narrowing downward + falling dots
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$cx = [int]($Size / 2)
$barH = [int]($Size * 0.075)
$gap = [int]($Size * 0.055)
$widths = @(0.56, 0.40, 0.24)
$startY = [int]($Size * 0.24)

for ($i = 0; $i -lt $widths.Count; $i++) {
  $w = [int]($Size * $widths[$i])
  $y = $startY + ($i * ($barH + $gap))
  $r = New-Object System.Drawing.Rectangle (($cx - [int]($w / 2))), $y, $w, $barH
  $rp = [int]($barH / 2)
  $bar = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bar.AddArc($r.X, $r.Y, $rp, $rp, 180, 90)
  $bar.AddArc($r.Right - $rp, $r.Y, $rp, $rp, 270, 90)
  $bar.AddArc($r.Right - $rp, $r.Bottom - $rp, $rp, $rp, 90, 90)
  $bar.AddArc($r.X, $r.Bottom - $rp, $rp, $rp, 0, 90)
  $bar.CloseFigure()
  $g.FillPath($white, $bar)
}

$dotR = [int]($Size * 0.042)
$dotY = $startY + (3 * ($barH + $gap)) + [int]($Size * 0.02)
$dotOffsets = @(-0.13, 0.0, 0.13)
for ($i = 0; $i -lt $dotOffsets.Count; $i++) {
  $dx = $cx + [int]($Size * $dotOffsets[$i])
  $g.FillEllipse($white, ($dx - $dotR), ($dotY - $dotR), ($dotR * 2), ($dotR * 2))
}

$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "wrote $Out"
