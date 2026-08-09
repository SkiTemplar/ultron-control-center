# Catalogo de patrones de texto IA

> Destilado de investigacion web (2026-08-09, 6 barridos paralelos + sintesis; ~100 fuentes: papers ICML/ICLR/NAACL/COLING, estudios de corpus, WP:AISIGNS, normativa universitaria espanola).
> Fuente de datos canonica para herramientas: patrones-texto-ia.json (mismo directorio).
> Uso: base del laboratorio TFG de ULTRON — deteccion de patrones IA en texto y guia de escritura natural. El TFG lo escribe su autor; esto detecta y apoya.

## 1. Patrones de texto IA (25)

### Vocabulario 'delve' y oleadas léxicas de IA (base inglesa)

Verbos/adjetivos que los LLM sobreusan muy por encima de su frecuencia natural, confirmado por estudios de corpus (Kobak et al., 14,2M abstracts PubMed; Juzek&Ward, COLING 2025, 21 'palabras focales'). La lista no es estática: cambia por oleada temporal (2023-med.2024: delve/boast/crucial/intricate/pivotal/tapestry/testament/underscore/vibrant; med.2024-2025: align with/enhance/fostering/highlighting/showcasing).
- Ejemplo (EN): This delves into the intricate landscape of...
- Ejemplo (ES): En TFG traducidos/asistidos aparece como calco: 'profundizar/ahondar en el intrincado panorama de...', 'desempeña un papel crucial/pivotal en...'
- Senal medible: Ratios medidos: 'delve' +6.697% de frecuencia 2020→2024 en PubMed (0.21→14.38 por millón de palabras); 'underscores' x9.1; 'intricate' x6.1.
- Correccion: Sustituir por verbos concretos según el contexto real ('explorar', 'analizar', 'examinar' solo si aportan matiz distinto); no usarlos como muletilla en cada párrafo.

### Vocabulario IA sobreusado en español

Palabras con ratio de sobrerrepresentación extremo en texto generado por IA en español, según análisis de corpus de Natzir Turrado (360M tokens, dato vía fuente secundaria no verificada contra paper primario) y catálogos editoriales (Genbeta, Infobae).
- Ejemplo (ES): 'Es crucial destacar los desafíos que exploraremos en este análisis...'
- Senal medible: 'crucial' reportado hasta ~6.413x más frecuente en texto IA que en equivalente humano; 'desafíos'/'exploraremos' ~2.000x (cifras de prensa tecnológica, no de paper académico revisado).
- Correccion: Usar el término solo cuando aporte precisión real; sustituir por formulación directa sin adjetivo de énfasis ('esto plantea un problema concreto: ...').

### Énfasis indebido en significado/legado

Frases que inflan la importancia de algo sin argumento concreto que lo sostenga (categoría central de WP:AISIGNS).
- Ejemplo (EN): stands as a testament to, marks a pivotal moment, leaves an indelible mark
- Ejemplo (ES): 'Esto supone un hito fundamental que deja una huella imborrable en el campo de estudio'
- Correccion: Explicar el porqué concreto de la relevancia (dato, consecuencia medible) en vez de declararla como axioma.

### Análisis superficial en gerundio

Cierre de frase en gerundio que añade una opinión no atribuida ni argumentada, típico de la salida de LLM.
- Ejemplo (EN): ...creating a lively community, highlighting their significance
- Ejemplo (ES): '...destacando así la importancia del fenómeno', 'subrayando su relevancia para el sector'
- Correccion: O se argumenta la conclusión con datos concretos, o se elimina la coletilla en gerundio.

### Lenguaje promocional/publicitario

Adjetivación de guía turística o marketing aplicada a un objeto de análisis académico.
- Ejemplo (EN): boasts a vibrant, groundbreaking approach nestled within...
- Ejemplo (ES): 'cuenta con un enfoque vibrante e innovador, enclavado en un ecosistema dinámico'
- Correccion: Describir con términos técnicos y datos verificables, no con adjetivos de valor.

### Atribuciones vagas sin fuente

Se invoca una autoridad genérica sin nombrarla, para dar apariencia de respaldo externo.
- Ejemplo (EN): Industry reports suggest..., Observers have cited...
- Ejemplo (ES): 'Diversos informes del sector señalan...', 'Algunos expertos argumentan que...'
- Correccion: Citar la fuente real (autor, año, DOI) o eliminar la afirmación si no hay fuente que la respalde.

### Fórmula de cierre rígida

Estructura de conclusión mecánica: elogio + lista de retos + apartado de 'perspectivas futuras' especulativas y vagas.
- Ejemplo (EN): Despite its achievements, X faces several challenges. Future Outlook: ...
- Ejemplo (ES): 'A pesar de sus logros, X enfrenta varios desafíos. De cara al futuro, será clave...'
- Correccion: Cerrar con la conclusión específica que se deriva de los resultados propios del TFG, no con una plantilla aplicable a cualquier tema.

### Evitación de la cópula simple ('es/son')

Sustitución sistemática del verbo 'ser' por verbos más rebuscados para sonar elaborado ('avoidance of basic copulatives', WP:AISIGNS).
- Ejemplo (EN): serves as, stands as, functions as, represents
- Ejemplo (ES): 'se erige como', 'funciona como', 'constituye' usados en vez de 'es' sin necesidad real
- Correccion: Usar 'es/son' cuando es la formulación natural; reservar el verbo alternativo para cuando aporte matiz real de función o rol.

### Paralelismo negativo 'no solo X, sino también Y'

Contraste que aparenta corregir una idea errónea que nadie había planteado.
- Ejemplo (EN): not only a technical solution, but also a methodological contribution
- Ejemplo (ES): 'no solo constituye una mejora técnica, sino también una aportación metodológica'
- Correccion: Afirmar directamente lo que se quiere decir: 'es una aportación metodológica, además de una mejora técnica'.

### Paralelismo negativo total 'no es X, sino Y'

Negación completa de una característica antes de afirmar la real, sin que el lector esperara la negada.
- Ejemplo (EN): not a mirror but a portal
- Ejemplo (ES): 'no es un simple resumen, sino un análisis crítico', usado sin que hiciera falta descartar primero la opción negada
- Correccion: Afirmar directamente ('es un análisis crítico basado en...') salvo que el contraste responda a una confusión real y documentada en el texto.

### 'X en lugar de Y' (variante invertida)

Variante del paralelismo negativo frecuente en salidas de Grok; se traduce al español de forma igual de mecánica.
- Ejemplo (EN): prioritizing empirical consolidation rather than ideological purity
- Ejemplo (ES): 'priorizando la consolidación empírica en lugar de la pureza ideológica'
- Correccion: Afirmar la posición propia sin necesidad de descartar la contraria en cada frase.

### Regla de tres (tricolon) obsesiva

Tríadas de adjetivos o frases cortas aplicadas mecánicamente para simular exhaustividad, incluso cuando el contenido no encaja en tres.
- Ejemplo (EN): clear, concise, and actionable
- Ejemplo (ES): 'claro, conciso y eficaz' repetido como estructura fija en cada enumeración del TFG
- Correccion: Listar tantos elementos como el contenido exija (dos, cuatro, siete), no forzar siempre tres.

### Variación léxica forzada (elegant variation)

Sustituir el mismo referente por sinónimos artificiales en vez de repetirlo, por el penalizador de repetición de los LLM.
- Ejemplo (ES): Llamar al mismo concepto sucesivamente 'el sistema', 'la plataforma', 'la herramienta', 'el software' en el mismo párrafo sin razón
- Correccion: Repetir el mismo término cuando es lo natural y no genera ambigüedad; el español académico tolera bien la repetición precisa de un término técnico.

### Artefactos de markup sin adaptar al formato destino

Restos de sintaxis Markdown u otros artefactos de copiar-pegar directo desde el chatbot, sin adaptar al procesador de texto o LaTeX del TFG. WP:AISIGNS cataloga además huellas forenses casi inequívocas por herramienta (ChatGPT: 'oaicite'/'contentReference'; Gemini: '[cite: 1]'; Grok: 'grok_card').
- Ejemplo (EN): **bold** sin convertir, [link](url) sin convertir
- Ejemplo (ES): Asteriscos dobles sueltos en el documento final, numeración de listas rota, corchetes de cita tipo '[cite: 1]' pegados por accidente
- Correccion: Revisar el documento final buscando literalmente estos artefactos y limpiarlos; nunca copiar-pegar la salida cruda del chatbot al documento.

### Encabezados genéricos repetidos en Title Case

Títulos de sección intercambiables entre cualquier tema, con mayúscula inicial en cada palabra (convención inglesa).
- Ejemplo (EN): Challenges and Future Prospects, Sustainable Development and Environmental Law
- Ejemplo (ES): 'Retos y Perspectivas de Futuro', 'Marco Teórico y Estado del Arte' aplicados como plantilla intercambiable, sin adaptar al contenido específico del capítulo
- Correccion: Titular cada sección según lo que de verdad contiene, en minúscula salvo inicio de frase o nombre propio (norma española).

### Guion largo (em dash) sobreusado

Uso desproporcionado del guion largo '—' donde el español usaría coma, paréntesis o dos puntos; señal tan notoria que OpenAI añadió control de usuario para suprimirla.
- Ejemplo (ES): 'El resultado —que era el esperado— confirma la hipótesis —planteada en el capítulo 2— del estudio'
- Correccion: Usar coma, paréntesis o punto y seguido según el registro académico español; reservar el guion largo para incisos puntuales, no como muletilla de puntuación en cada frase.

### Falsos rangos sin detalle real

'Desde X hasta Y' usado para aparentar exhaustividad sin desarrollar ninguno de los elementos intermedios.
- Ejemplo (EN): ranging from basic implementations to advanced techniques
- Ejemplo (ES): 'abarca desde implementaciones básicas hasta técnicas avanzadas', sin especificar ninguna de las dos
- Correccion: Nombrar explícitamente los elementos del rango o eliminar la generalización vacía.

### Inserciones editoriales / contrastes forzados

El texto opina sobre qué es relevante sin que se le haya pedido, o fuerza un contraste artificial para dar sensación de matiz.
- Ejemplo (EN): It's important to note that..., It's not just about X, it's about Y
- Ejemplo (ES): 'Es importante tener en cuenta que...', 'Cabe destacar que...', 'Vale la pena señalar que...'
- Correccion: Eliminar la coletilla y exponer directamente el hecho: si es importante, se nota en cómo se usa la información, no en anunciarlo.

### Throat-clearing openers (aperturas genéricas)

Frases de apertura de párrafo o sección que no aportan información, solo preceden a la idea real.
- Ejemplo (EN): In today's fast-paced world...
- Ejemplo (ES): 'En el mundo actual...', 'En la sociedad actual, cada vez más...'
- Correccion: Empezar directamente con la idea o el dato, sin preámbulo genérico.

### Gerundio calcado del inglés (español)

Uso del gerundio con valor de simultaneidad que no existe en español, calco de estructuras -ing inglesas.
- Ejemplo (ES): 'Analizando los datos, se concluye que...' en vez de 'Al analizar los datos, se concluye que...' o 'Tras analizar los datos...'
- Correccion: Sustituir por 'al + infinitivo', 'tras + infinitivo' o una subordinada causal/temporal explícita.

### Mayúsculas tipo inglés en títulos (español)

Aplicar mayúscula a cada palabra principal del título, siguiendo la convención inglesa de Title Case, en vez de la norma ortográfica española.
- Ejemplo (ES): 'Análisis Comparativo De Los Modelos De Detección' en vez de 'Análisis comparativo de los modelos de detección'
- Correccion: Solo mayúscula inicial de la frase y nombres propios, según la ortografía española.

### 'Español neutro' sin diatopismos

El texto evita marcas regionales y usa vocabulario panhispánico 'neutro' en vez del propio del español de España, por el sesgo del corpus de entrenamiento del modelo.
- Ejemplo (ES): 'computadora' en vez de 'ordenador'; ausencia de giros o expresiones propias del español de España que un estudiante usaría de forma natural
- Correccion: Usar el léxico propio de la variedad de español del autor (ordenador, móvil, coger, etc.) sin 'corregirlo' hacia lo neutro.

### Hedging uniforme y excesivo

Matizar todas las frases por igual con 'podría', 'parece', 'en cierta medida', en vez de reservar la matización a donde hay incertidumbre real.
- Ejemplo (ES): 'Esto podría sugerir, en cierta medida, que el modelo parece funcionar razonablemente bien'
- Correccion: Afirmar sin matiz los hechos verificados ('el modelo obtiene un F1 de 0.94') y reservar el hedge para la interpretación incierta, solo cuando de verdad hay incertidumbre.

### Monotonía de longitud de frase (baja burstiness)

Oraciones de longitud y estructura casi idéntica a lo largo de todo el texto, ritmo predecible al leer en voz alta. Correlato sintáctico medible del texto IA (burstiness humana 0.6-1.2 vs. 0.2-0.4 en GPT, como orden de magnitud orientativo, no prueba aislada).
- Ejemplo (ES): Un párrafo entero de frases de 18-22 palabras, todas con estructura sujeto-verbo-complemento sin variación
- Correccion: Alternar deliberadamente frases cortas de impacto con frases largas de desarrollo; leer el párrafo en voz alta para detectar la monotonía.

### Razonamiento excesivamente equilibrado y relleno sin contenido

Presentar 'por un lado / por otro lado' en cada argumento aunque el contexto no lo requiera, y párrafos de pulido superficial que no aportan información nueva (filler / 'surface polish with nothing underneath').
- Ejemplo (ES): 'Por un lado, esta técnica presenta ventajas; por otro lado, también tiene limitaciones' repetido como estructura fija en cada apartado, incluso cuando el propio TFG ya se ha posicionado
- Correccion: Comprometerse con la conclusión que los datos del TFG respaldan; eliminar todo párrafo que se pueda resumir en una frase sin pérdida real de información.

## 2. Metodos de deteccion (10)

### Binoculars

- Como funciona: Zero-shot: pasa el texto por dos LLM causales relacionados (por defecto Falcon-7B y Falcon-7B-Instruct) y calcula el ratio de 'cross-perplexity' entre ambos, sin entrenamiento supervisado.
- Fiabilidad (honesta): >90% de detección de ChatGPT con 0.01% de falsos positivos en el paper (ICML 2024), sobre texto en inglés sin ataque. El propio repositorio admite explícitamente ser más débil en idiomas no ingleses (no validado en español); se degrada fuerte bajo ataques de parafraseo (ver DIPPER/RAID).
- Factible en local: Requiere GPU con VRAM suficiente para cargar dos LLM de 7B simultáneamente — inviable en CPU de consumo.

### Fast-DetectGPT

- Como funciona: Zero-shot: mide 'curvatura de probabilidad condicional' vía muestreo de tokens, en vez de las perturbaciones costosas de DetectGPT original.
- Fiabilidad (honesta): 340x más rápido y ~75% más preciso (AUROC relativo) que DetectGPT original según el paper (ICLR 2024) en condiciones controladas. Sin ataque de parafraseo; el propio linaje de DetectGPT cae de 70.3% a 4.6% de precisión bajo el ataque DIPPER a FPR fija del 1%.
- Factible en local: Necesita GPU (modelo de scoring desde GPT-Neo-2.7B hasta Llama3-8B) — inviable en CPU, viable en GPU de consumo con VRAM moderada. Sin soporte explícito de español.

### Ghostbuster

- Como funciona: Clasificador entrenado: pasa el texto por varios LLM 'débiles', hace búsqueda estructurada de combinaciones de sus features (n-gramas/logprobs) y entrena un clasificador simple sobre esas features seleccionadas. Funciona en caja negra: no necesita logprobs del modelo generador real.
- Fiabilidad (honesta): 99.0 F1 cross-dominio (ensayos, escritura creativa, noticias) en el paper (NAACL 2024). Solo validado en inglés; el propio README nota limitaciones con inglés no nativo.
- Factible en local: El clasificador final es CPU-viable (regresión sobre features), pero requiere ejecutar varios LM auxiliares para extraer esas features — coste moderado, sin necesitar GPU dedicada si se usan modelos pequeños.

### GLTR

- Como funciona: Herramienta visual/forense: colorea cada palabra del texto según su rank de probabilidad y la entropía de la predicción, bajo un modelo de referencia (originalmente GPT-2).
- Fiabilidad (honesta): Señal débil contra LLMs modernos porque se basa en GPT-2 (2019); una reimplementación reciente con LLMs modernos como base obtiene solo F1 macro 66.2% — la 'predictibilidad léxica' pierde fuerza discriminativa cuanto mejor es el modelo generador.
- Factible en local: Sí, 100% CPU con GPT-2-small, vía servidor Flask local (incluye Dockerfile) — la opción más ligera para experimentar, pero hoy poco fiable como detector aislado.

### ZipPy (ratio de compresión LZMA)

- Como funciona: Compara la compresibilidad del texto de entrada contra un corpus pequeño (<100KiB) de texto IA conocido: texto con menor 'sorpresa' comprime mejor.
- Fiabilidad (honesta): ~50x más rápido que un clasificador RoBERTa según el blog del propio autor (no revisado por pares). Literatura reciente advierte que el ratio de compresión está confundido con longitud y dominio del texto, no captura una 'firma generativa' estable — debería usarse solo como una feature más dentro de un ensemble, no como detector único.
- Factible en local: Sí, <200 líneas de Python, 100% CPU, sin modelo de lenguaje pesado — el más portable y el más fácil de adaptar a español construyendo un corpus de referencia propio.

### RADAR

- Como funciona: Entrenamiento adversarial estilo GAN entre un parafraseador (que intenta evadir) y un detector (que se adapta), para producir un clasificador robusto frente a parafraseo.
- Fiabilidad (honesta): Único de 6 métodos comparados en el paper (NeurIPS 2023) que mantiene rendimiento alto tras parafraseo con 8 LLM distintos — relevante porque el parafraseo con otra IA (herramientas 'humanizadoras') es la técnica de evasión más común en la práctica.
- Factible en local: Repo activo (push 2025); requiere GPU para inferencia del clasificador entrenado; sin cifra exacta de requisitos de hardware en la documentación revisada.

### Desklib AI Text Detector

- Como funciona: Fine-tune de microsoft/deberta-v3-large (no entrenado desde cero) sobre datos etiquetados humano-vs-IA; existe variante 'academic' afinada para textos académicos.
- Fiabilidad (honesta): Reportado por terceros como líder del benchmark RAID entre detectores abiertos evaluados. El propio autor advierte que la variante académica rinde peor en textos creativos/generales. Solo inglés.
- Factible en local: Sí, CPU viable pero lento: ~4-6 minutos por artículo de 1500 palabras (mayormente carga inicial del modelo de ~1.5GB) — factible para analizar un documento puntual de un TFG, no para lote masivo sin GPU.

### Stylometría clásica (perplexity + burstiness + textstat/stylometry-python)

- Como funciona: Extrae features estadísticas (previsibilidad léxica, varianza de longitud de frase, riqueza léxica, sílabas por palabra) y las alimenta a un clasificador simple (regresión logística / random forest).
- Fiabilidad (honesta): Un estudio combinando features estilométricas reporta F1=0.94, muy por encima de usar solo perplexity aislada. Pero perplexity/burstiness aisladas fallan documentadamente: sesgo contra no-nativos (61.3% de falso positivo en ensayos TOEFL, estudio de Stanford) y falsos positivos en géneros técnicos de baja burstiness natural (specs, textos legales) que no son señal de IA.
- Factible en local: Sí, 100% CPU, sin GPU ni modelo de lenguaje pesado (numpy/matplotlib/scikit-learn). La opción más realista para un TFG en español si se construye un corpus propio de entrenamiento (p. ej. usando AuTexTification/IberAuTexTification).

### Watermarking (SynthID-Text)

- Como funciona: Modifica las probabilidades de token durante la generación del propio LLM para insertar una señal estadística detectable pero imperceptible para el lector.
- Fiabilidad (honesta): Robusto en producción a escala (desplegado en Gemini con ~20M usuarios, sin caída de calidad percibida). Pero vulnerable a 'scrubbing': >90% de éxito eliminándolo con paraphrasers estándar (análisis independiente del SRI Lab, ETH Zürich); un estudio posterior (WaterPark, EMNLP Findings 2025) desmiente además afirmaciones previas de robustez de otros watermarkers (ej. UPV resulta más propenso a falsos positivos que TGRL bajo evaluación comparable, contradiciendo la literatura anterior).
- Factible en local: NO aplicable para detectar texto ajeno ya escrito: solo funciona si el propio generador (ej. Gemini) insertó la marca al crearlo; inútil contra ChatGPT/Claude/otros modelos sin watermark propio.

### Detectores comerciales SaaS (Turnitin, GPTZero, Originality.ai, ZeroGPT, Copyleaks)

- Como funciona: Cajas negras propietarias, metodología no publicada (combinación probable de perplexity/burstiness/clasificadores entrenados).
- Fiabilidad (honesta): Fiabilidad muy dispar y con contradicciones documentadas entre fuentes. Turnitin declara <1% de falso positivo a nivel documento (solo si ≥20% marcado como IA; a nivel de frase sube a ~4%) y su estudio interno de 2023 no halla sesgo contra no-nativos (1.4% vs 1.3%) — esto CONTRADICE directamente el estudio de Stanford (61.3% de falso positivo en ensayos TOEFL de no-nativos) y estudios independientes posteriores que reportan 5-12%, hasta ~50% en muestras pequeñas. GPTZero publicita ~99% de precisión pero pruebas independientes miden 16-20% de falso positivo (hasta 61.3% en no-nativos) y una re-medición de 2026 sitúa su precisión real en 79-85%. ZeroGPT es el peor documentado: 70-85% de precisión, 15-25% de falso positivo, hasta 50% en textos formales/académicos. Un estudio revisado por pares (JALT, 2025) confirma que ZeroGPT y GPTZero se degradan mucho más que Turnitin bajo parafraseo, y documenta que el mismo detector da puntuaciones distintas para el mismo texto en ejecuciones distintas.
- Factible en local: NO — son servicios cerrados de pago, sin metodología publicada ni posibilidad de ejecutarlos ni auditarlos localmente.

## 3. Principios de escritura natural (11)

### Especificidad concreta por encima de la generalidad

- Aplicacion: Usar datos, números y anécdotas concretas del propio proceso de investigación del TFG en vez de afirmaciones genéricas aplicables a cualquier trabajo.
- Evidencia: Ejemplo canónico citado en la literatura de escritura: 'una alumna de segundo que suspendió el examen de conducir tres veces' golpea más que 'una joven que tuvo dificultades'. El LLM tiende a evitar el detalle particular porque optimiza hacia la respuesta media del corpus de entrenamiento.

### Voz con opinión y riesgo propio (Zinsser, 'On Writing Well')

- Aplicacion: Tomar postura clara en la discusión/conclusiones del TFG en vez de cubrir todos los ángulos por igual; dejar aflorar la perspectiva propia del autor.
- Evidencia: Zinsser: el estilo viene de tener opiniones y de la simplicidad, de ser uno mismo, no de palabras rebuscadas — estructuralmente opuesto a un modelo instruction-tuned, que por diseño busca consenso y evita comprometerse con una posición fuerte.

### Hedging reservado para la inferencia, no para todo

- Aplicacion: Matizar solo donde hay incertidumbre real ('los datos sugieren que...' para una inferencia), evitando 'podría'/'parece' repetido mecánicamente en cada frase.
- Evidencia: Guías de escritura académica distinguen el hedge epistémico bien anclado en evidencia de la matización uniforme de todo el texto; matizar todo por igual aplana la voz y es un patrón detectable de indecisión mecánica, no de rigor.

### Diversidad real de longitud de frase (burstiness)

- Aplicacion: Alternar deliberadamente frases cortas de impacto con cláusulas largas de desarrollo, en vez de mantener una cadencia uniforme en todo el capítulo.
- Evidencia: Burstiness humana típica 0.6-1.2 frente a 0.2-0.4 en salida de GPT (rango orientativo, no prueba aislada); estudios de corpus muestran mayor rango y diversidad de longitud de frase en texto humano frente a LLM.

### Reescritura real, no retoque cosmético

- Aplicacion: Al partir de un borrador asistido por IA, reescribir de verdad con palabras propias (alta distancia de edición a nivel de carácter), no solo cambiar sinónimos sueltos.
- Evidencia: Estudio de detección midió: texto de IA sin editar se detectó al 74%; el mismo texto tras edición humana real cayó a 42%. La distancia de edición a nivel de carácter emergió como el predictor más fuerte de si el texto se detecta o no.

### No forzar variación léxica artificial (evitar 'elegant variation')

- Aplicacion: Repetir el mismo término cuando es lo natural, en vez de buscar sinónimos artificiales cada vez que se menciona el mismo referente técnico.
- Evidencia: El catálogo de Wikipedia documenta la 'lexical diversity/elegant variation' como patrón de IA causado por el penalizador de repetición de los LLM; el español académico tolera bien la repetición precisa de un término técnico.

### No sobre-equilibrar el razonamiento

- Aplicacion: No presentar sistemáticamente 'por un lado / por otro lado' en cada argumento si el contexto no lo exige; comprometerse con la conclusión que la evidencia del propio TFG respalda.
- Evidencia: Guías bibliotecarias universitarias documentan el 'overly balanced reasoning' (ponderar ambos lados aunque el contexto no lo requiera) como señal de escritura IA.

### Incluir el proceso real de investigación, no solo el resultado pulido

- Aplicacion: Reflejar decisiones metodológicas concretas, dudas y callejones sin salida reales del propio proceso del TFG, no solo conclusiones ya limpias.
- Evidencia: Guías de detección académica señalan la ausencia de esa 'capa de intimidad personal' (anécdota, voz propia, proceso visible) como rasgo característico del texto generado por IA.

### Estructura de párrafo adaptada al contenido, no plantillada

- Aplicacion: Evitar encabezados y esquemas genéricos repetidos de forma idéntica en cada capítulo ('Retos y perspectivas futuras'); adaptar la estructura a lo que cada sección realmente aporta.
- Evidencia: El catálogo de Wikipedia documenta encabezados-plantilla intercambiables como parte de un 'cluster' de señales de IA que suelen aparecer juntas.

### Usar la cópula simple ('es/son') cuando corresponde

- Aplicacion: No sustituir sistemáticamente 'es' por 'sirve como', 'se erige como', 'representa'; usar el verbo simple salvo que el verbo alternativo aporte un matiz real de función o rol.
- Evidencia: WP:AISIGNS documenta la 'avoidance of basic copulatives' como patrón léxico distintivo y verificado de texto generado por IA.

### Registro propio del español de España, sin 'neutralizar'

- Aplicacion: Mantener el léxico y los giros propios de la variedad de español del autor (ordenador, coger, móvil) en vez de corregirlos hacia un 'español neutro' panhispánico.
- Evidencia: Guías de detección en español señalan el 'español neutro' que evita diatopismos como rasgo típico de texto generado por IA, por el sesgo de los corpus de entrenamiento hacia variantes más representadas.

## 4. Universidades espanolas y TFG

Tendencia dominante 2024-2026 en España: exigir declaración de uso de IA en el TFG/TFM, no prohibirla. CRUE publicó en marzo de 2024 su guía marco "La inteligencia artificial generativa en la docencia universitaria" como referencia para regular (no vetar) el uso de IA; universidades la usan como base para actualizar su normativa de TFG. UC3M exige desde el curso 2024-2025 una "Declaración de Uso de Inteligencia Artificial Generativa" como anexo obligatorio del TFG/TFM, con el uso permitido bajo las condiciones que fije cada titulación. UCM (normativa aprobada 13-jul-2023, BOUC nº32) incluye un Anexo de "declaración de responsabilidad sobre autoría y uso ético de herramientas de IA" firmado conjuntamente por estudiante y tutor, con un campo de "porcentaje estimado de trabajo asistido por IA". Turnitin es la herramienta de detección de referencia en el ecosistema universitario español: adoptada por 79 instituciones (entre ellas Nebrija, Pompeu Fabra, Salamanca, Granada, UAM), recomendada por CRUE desde 2015, con licenciamiento coordinado en Madrid vía el Consorcio Madroño. Cifras concretas de adopción (p. ej. "67-78% de universidades exige declaración", "sanción en 0,25-0,40% de los TFG") circulan casi exclusivamente en fuentes comerciales tipo tesify.es, sin estudio primario verificable citado — deben tratarse como estimación de mercado, no como dato contrastado; para el TFG conviene verificar la normativa de cada universidad directamente en su web. Contradicción documentada dentro del propio ecosistema Turnitin: su estudio interno de 2023 no halla sesgo estadísticamente significativo contra estudiantes no-nativos de inglés (1,4% vs 1,3% de falso positivo), mientras que otras cifras citadas de la propia empresa hablan de 6-9% de falso positivo en no-nativos frente a 1-4% en nativos — y ambas contradicen el estudio académico de Stanford (Liang et al. 2023), que mide un 61,3% de falso positivo en ensayos no-nativos con detectores GPT genéricos. Consenso experto transversal (Weber-Wulff, autora del estudio comparativo de detectores más citado, y práctica observada en tribunales españoles): la defensa oral del TFG sigue siendo la salvaguarda real frente al uso indebido de IA, no el score de un detector automático — las discrepancias entre el texto escrito y el dominio conceptual del estudiante en la defensa oral delatan el problema con más fiabilidad que cualquier herramienta automática, y ningún detector debería usarse como prueba única en un proceso disciplinario.

## 5. Fuentes (101)

- https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
- https://www.forbes.com/sites/jodiecook/2025/09/08/the-10-giveaway-signs-of-ai-writing-wikipedia-reveals/
- https://gptzero.me/ai-vocabulary
- https://aclanthology.org/2025.coling-main.426/
- https://arxiv.org/abs/2406.07016
- https://arxiv.org/html/2406.07016v1
- https://www.medrxiv.org/content/10.1101/2024.05.14.24307373v2.full
- https://arxiv.org/abs/2403.07183
- https://retractionwatch.com/2026/02/18/correction-retraction-tortured-phrases-llm-text-spinners/
- https://www.ignorance.ai/p/the-field-guide-to-ai-slop
- https://beingovee.substack.com/p/chatgpts-100-favourite-words-and
- https://www.genbeta.com/inteligencia-artificial/estas-palabras-frases-tus-textos-dejan-claro-has-usado-chatgpt
- https://x.com/natzir9/status/1816039368919830599
- https://library.daytonastate.edu/GenerativeAI/checklist
- https://arxiv.org/pdf/2412.11385
- https://news.fsu.edu/news/science-technology/2025/02/17/why-does-chatgpt-delve-so-much-fsu-researchers-begin-to-uncover-why-chatgpt-overuses-certain-words/
- https://arxiv.org/html/2409.01754v1
- https://www.infobae.com/educacion/2024/04/15/estas-son-las-palabras-que-revelan-que-un-texto-fue-escrito-por-la-ia/
- https://www.paradigmadigital.com/dev/sabrias-identificar-textos-generados-ia-sin-usar-detectores/
- https://www.rollingstone.com/culture/culture-features/chatgpt-hypen-em-dash-ai-writing-1235314945/
- https://traductorinterprete.es/detectar-textos-escritos-con-ia/
- https://hastewire.com/es/blog/guia-para-detectar-gpt-en-redacciones-estudiantiles
- https://www.culturamas.es/2026/03/18/como-saber-si-un-texto-ha-sido-escrito-por-una-ia-indicios-y-ejemplos-reales/
- https://github.com/ahans30/Binoculars
- https://arxiv.org/abs/2401.12070
- https://github.com/baoguangsheng/fast-detect-gpt
- https://openreview.net/forum?id=Bpcgcr8E8Z
- https://github.com/vivek3141/ghostbuster
- https://arxiv.org/abs/2305.15047
- https://aclanthology.org/2024.naacl-long.95/
- https://github.com/HendrikStrobelt/detecting-fake-text
- https://arxiv.org/abs/2502.12064
- https://github.com/thinkst/zippy
- https://github.com/IBM/RADAR
- https://github.com/desklib/ai-text-detector
- https://github.com/textstat/textstat
- https://pypi.org/project/stylometry-python/
- https://github.com/CWOnline/AIWords
- https://github.com/Hello-SimpleAI/chatgpt-comparison-detection
- https://github.com/Genaios/IberAuTexTification
- https://arxiv.org/abs/2310.13606
- https://github.com/pan-webis-de/pan24-generative-ai-authorship-verification
- https://github.com/liamdugan/raid
- https://arxiv.org/abs/2405.07940
- https://its-ai.org/en/accuracy
- https://www.nature.com/articles/s41586-024-08025-4
- https://deepmind.google/blog/watermarking-ai-generated-text-and-video-with-synthid/
- https://www.sri.inf.ethz.ch/blog/probingsynthid
- https://arxiv.org/abs/2411.13425
- https://aclanthology.org/2025.findings-emnlp.1148/
- https://arxiv.org/abs/2304.02819
- https://pubmed.ncbi.nlm.nih.gov/37521038/
- https://www.sciencedirect.com/science/article/pii/S2666389923001307
- https://www.sciencedaily.com/releases/2023/07/230710113921.htm
- https://www.turnitin.com/blog/understanding-false-positives-within-our-ai-writing-detection-capabilities
- https://www.turnitin.com/blog/new-research-turnitin-s-ai-detector-shows-no-statistically-significant-bias-against-english-language-learners
- https://www.insidehighered.com/news/quick-takes/2023/06/01/turnitins-ai-detector-higher-expected-false-positives
- https://doi.org/10.1007/s40979-023-00146-z
- https://gptzero.me/news/ai-accuracy-benchmarking/
- https://ryne.ai/blog/why-gptzero-is-not-reliable-anymore-we-ran-100000-texts-to-prove-it
- https://mpgone.com/is-gptzero-accurate-our-2025-test-results-here/
- https://copyleaks.com/blog/ai-detector-continues-top-accuracy-third-party
- https://fast.io/resources/copyleaks-ai-detector-review-2026/
- https://naturalwrite.com/blog/is-zerogpt-accurate
- https://www.bypassgpt.ai/reviews/is-zerogpt-accurate
- https://journals.sfu.ca/jalt/index.php/jalt/article/view/2411
- https://arxiv.org/abs/2312.05241
- https://www.aol.com/news/student-autism-sues-adelphi-university-194800404.html
- https://www.rollingstone.com/culture/culture-features/student-accused-ai-cheating-turnitin-1234747351/
- https://sfstandard.com/2026/05/11/ai-detection-cheating-palo-alto/
- https://www.paloaltoonline.com/palo-alto-schools/2026/06/26/palo-alto-unified-fights-150-million-lawsuit-over-ai-use-in-students-essay/
- https://www.crue.org/wp-content/uploads/2024/03/Crue-Digitalizacion_IA-Generativa.pdf
- https://aquibiblioteca.uc3m.es/2024/10/14/declaracion-de-uso-de-inteligencia-artificial-generativa-en-tfg-y-tfm/
- https://uc3m.libguides.com/TFG/IAGenerativa
- https://www.magisnet.com/2021/10/turnitin-la-solucion-que-ayuda-a-las-universidades-espanolas-a-mantener-la-integridad-academica/
- https://www.consorciomadrono.es/en/
- https://www.studytexter.com/es/chatgpt-tesis-plagio
- https://cte.ku.edu/we-cant-detect-our-way-out-of-the-ai-challenge
- https://tesify.es/declaracion-uso-ia-tfg-2026-plantilla-editable-paso-a-paso
- https://tesify.es/originality-ai-espanol-tfg-opinion-2026
- https://www.eyesift.com/faq/ai-detection-schools-policy-turnitin-false-positives-2026/
- https://arxiv.org/abs/2303.13408
- https://github.com/martiansideofthemoon/ai-detection-paraphrases
- https://arxiv.org/abs/2303.11156
- https://arxiv.org/abs/2505.14608
- https://techcrunch.com/2023/07/25/openai-scuttles-ai-written-text-detector-over-low-rate-of-accuracy/
- https://openai.com/index/new-ai-classifier-for-indicating-ai-written-text/
- https://www.tryleap.ai/learn/perplexity-vs-burstiness
- https://www.pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai
- https://gptzero.me/news/perplexity-and-burstiness-what-is-it/
- https://www.pangram.com/blog/can-you-avoid-ai-detection-through-editing
- https://arxiv.org/html/2402.14873v3
- https://www.pangram.com/blog/third-party-pangram-evals
- https://www.masterclass.com/articles/how-to-use-concrete-details-to-enhance-your-writing
- https://theintuitivedesk.com/the-importance-of-using-specificity-and-concrete-language-in-your-writing/
- https://www.archbee.com/blog/book-review-william-zinssers-on-writing-well
- https://casrai.org/guides/hedging-in-academic-writing
- https://www.ref-n-write.com/blog/hedging-techniques-in-academic-writing-with-examples/
- https://arxiv.org/pdf/2308.09067
- https://www.trinka.ai/blog/how-sentence-length-variation-improves-academic-readability/
- https://www.infobae.com/tecno/2026/02/03/como-humanizar-textos-de-ia-los-mejores-prompts-para-que-no-sepan-que-usaste-chatgpt-o-gemini/
