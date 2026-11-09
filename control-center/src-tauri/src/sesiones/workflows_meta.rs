// sesiones/workflows_meta.rs — `export const meta = { name, description,
// phases }` del script de un `Workflow`, sin evaluar JavaScript.
//
// Analizador mínimo de literales de objeto: cadenas ('…', "…", `…`),
// arrays, objetos y claves identificador o cadena. Cualquier otra expresión
// (variables, llamadas, spread) se salta hasta la coma o el cierre de su
// nivel. Un `meta` construido de forma dinámica deja solo lo literal; si no
// hay `meta`, `None` y la tarjeta usa el JSON final o el journal.

/// Metadatos declarados por el script.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetaScript {
    pub name: Option<String>,
    pub description: Option<String>,
    /// (título, detalle) en el orden del script.
    pub phases: Vec<(String, Option<String>)>,
}

#[derive(Debug)]
enum Js {
    Str(String),
    Arr(Vec<Js>),
    Obj(Vec<(String, Js)>),
    Otro,
}

impl Js {
    fn campo(&self, k: &str) -> Option<&Js> {
        match self {
            Js::Obj(c) => c.iter().find(|(n, _)| n == k).map(|(_, v)| v),
            _ => None,
        }
    }

    fn texto(&self, k: &str) -> Option<String> {
        match self.campo(k)? {
            Js::Str(s) => Some(s.clone()),
            _ => None,
        }
    }
}

/// Extrae el `meta` del texto de un script.
pub fn parse_meta(script: &str) -> Option<MetaScript> {
    let inicio = script.find("export const meta")?;
    let resto = &script[inicio..];
    let llave = resto.find('{')?;
    let chars: Vec<char> = resto[llave..].chars().collect();
    let mut p = Parser { s: &chars, i: 0 };
    let obj = p.valor();
    if !matches!(obj, Js::Obj(_)) {
        return None;
    }
    let phases = match obj.campo("phases") {
        Some(Js::Arr(items)) => items
            .iter()
            .filter_map(|f| f.texto("title").map(|t| (t, f.texto("detail"))))
            .collect(),
        _ => Vec::new(),
    };
    Some(MetaScript {
        name: obj.texto("name"),
        description: obj.texto("description"),
        phases,
    })
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

impl Parser<'_> {
    fn ver(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn saltar_blancos(&mut self) {
        while let Some(c) = self.ver() {
            if c.is_whitespace() {
                self.i += 1;
            } else if c == '/' && self.s.get(self.i + 1) == Some(&'/') {
                while self.ver().is_some_and(|c| c != '\n') {
                    self.i += 1;
                }
            } else if c == '/' && self.s.get(self.i + 1) == Some(&'*') {
                self.i += 2;
                while self.i < self.s.len()
                    && !(self.ver() == Some('*') && self.s.get(self.i + 1) == Some(&'/'))
                {
                    self.i += 1;
                }
                self.i = (self.i + 2).min(self.s.len());
            } else {
                return;
            }
        }
    }

    fn valor(&mut self) -> Js {
        self.saltar_blancos();
        match self.ver() {
            Some('{') => self.objeto(),
            Some('[') => self.array(),
            Some(q @ ('\'' | '"' | '`')) => Js::Str(self.cadena(q)),
            _ => {
                self.saltar_expresion();
                Js::Otro
            }
        }
    }

    /// Cadena con escapes simples; un template literal se toma tal cual.
    fn cadena(&mut self, q: char) -> String {
        self.i += 1;
        let mut out = String::new();
        while let Some(c) = self.ver() {
            self.i += 1;
            match c {
                '\\' => {
                    if let Some(e) = self.ver() {
                        self.i += 1;
                        out.push(match e {
                            'n' => '\n',
                            't' => '\t',
                            otro => otro,
                        });
                    }
                }
                c if c == q => return out,
                c => out.push(c),
            }
        }
        out
    }

    /// Salta una expresión no literal hasta `,`, `}` o `]` de su nivel.
    fn saltar_expresion(&mut self) {
        let mut nivel = 0usize;
        while let Some(c) = self.ver() {
            match c {
                '\'' | '"' | '`' => {
                    self.cadena(c);
                    continue;
                }
                '{' | '[' | '(' => nivel += 1,
                '}' | ']' | ')' if nivel == 0 => return,
                '}' | ']' | ')' => nivel -= 1,
                ',' if nivel == 0 => return,
                _ => {}
            }
            self.i += 1;
        }
    }

    fn array(&mut self) -> Js {
        self.i += 1;
        let mut items = Vec::new();
        loop {
            self.saltar_blancos();
            match self.ver() {
                None => return Js::Arr(items),
                Some(']') => {
                    self.i += 1;
                    return Js::Arr(items);
                }
                Some(',') => self.i += 1,
                Some(_) => {
                    let antes = self.i;
                    items.push(self.valor());
                    if self.i == antes {
                        self.i += 1;
                    }
                }
            }
        }
    }

    fn clave(&mut self) -> Option<String> {
        match self.ver()? {
            q @ ('\'' | '"') => Some(self.cadena(q)),
            c if c.is_alphanumeric() || c == '_' || c == '$' => {
                let ini = self.i;
                while self
                    .ver()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
                {
                    self.i += 1;
                }
                Some(self.s[ini..self.i].iter().collect())
            }
            _ => None,
        }
    }

    fn objeto(&mut self) -> Js {
        self.i += 1;
        let mut campos = Vec::new();
        loop {
            self.saltar_blancos();
            match self.ver() {
                None => return Js::Obj(campos),
                Some('}') => {
                    self.i += 1;
                    return Js::Obj(campos);
                }
                Some(',') => self.i += 1,
                Some(_) => self.campo(&mut campos),
            }
        }
    }

    fn campo(&mut self, campos: &mut Vec<(String, Js)>) {
        let antes = self.i;
        let Some(k) = self.clave() else {
            self.saltar_expresion();
            if self.i == antes {
                self.i += 1;
            }
            return;
        };
        self.saltar_blancos();
        if self.ver() == Some(':') {
            self.i += 1;
            campos.push((k, self.valor()));
        } else {
            self.saltar_expresion();
        }
    }
}
