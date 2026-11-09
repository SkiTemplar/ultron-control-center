// Comentario previo con meta falso: title: 'no'
export const meta = {
  name: 'demo-multilinea',
  description: "Descripción con \"comillas\" y acentos: fusión",
  phases: [
    { title: 'Diagnose', detail: 'lectura y diseño' },
    /* fase comentada { title: 'Nope' } */
    { title: `Implement`, detail: `con ${'plantilla'}` },
    { title: 'Review' },
  ],
}

const otra = { title: 'Fuera de phases' }
