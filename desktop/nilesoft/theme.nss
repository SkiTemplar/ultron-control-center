// Tema "halo glass" para Nilesoft Shell: cristal acrilico tintado de negro, filo blanco tenue y seleccion
// gris clara, igual que el dock, la bandeja y las ventanas de LienzoDesk.
theme
{
	name = "modern"
	view = view.large
	dark = true
	background
	{
		color = #05060A
		opacity = 90
		effect = [3, #05060A, 70]
	}
	item
	{
		radius = 6
		text
		{
			normal = #F2F3F5
			normal.disabled = #7E8088
			select = #FFFFFF
			select.disabled = #7E8088
		}
		back
		{
			select = #2A2C33
			select.disabled = #00000000
		}
		padding { left = 10 top = 6 right = 16 bottom = 6 }
		margin { left = 4 top = 1 right = 4 bottom = 1 }
	}
	border
	{
		enabled = true
		size = 1
		color = #FFFFFF
		opacity = 22
		radius = 8
		padding { left = 2 top = 4 right = 2 bottom = 4 }
	}
	shadow
	{
		enabled = true
		size = 10
		color = #000000
		opacity = 40
		offset = 4
	}
	font
	{
		size = 17
		name = "Segoe UI"
	}
	separator
	{
		size = 1
		color = #24262C
		margin { left = 10 top = 3 right = 10 bottom = 3 }
	}
	image.align = 2
}
