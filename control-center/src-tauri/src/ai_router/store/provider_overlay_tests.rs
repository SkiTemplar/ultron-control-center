use super::*;
use crate::ai_router::types::{ProviderKind, TestRootGuard};

fn custom(id: &str) -> Provider {
    let mut p = seed_providers()
        .into_iter()
        .find(|p| p.id == "groq")
        .expect("groq en el seed");
    p.id = id.into();
    p.custom = true;
    p.kind = ProviderKind::Cloud;
    p.base_url = "https://llm.interno.example/v1".into();
    p.key_env_var = "ULTRON_KEY_INTERNO".into();
    p
}

fn catalog_on_disk() -> Vec<Provider> {
    read_json(&providers_path().expect("path")).expect("providers.json")
}

fn local_on_disk() -> LocalProviders {
    read_json(&providers_local_path().expect("path")).expect("providers.local.json")
}

/// Caso negativo del hallazgo de privacidad: un alta o un descubrimiento no
/// escriben nada del usuario en el `providers.json` versionado.
#[test]
fn el_estado_del_usuario_va_al_fichero_local() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    update_providers(|ps| {
        ps.push(custom("interno"));
        let groq = ps.iter_mut().find(|p| p.id == "groq").expect("groq");
        groq.models = vec!["descubierto-1".into(), "descubierto-2".into()];
        Ok(())
    })
    .expect("update");

    let catalog = catalog_on_disk();
    assert!(catalog.iter().all(|p| !p.custom), "sin personalizados");
    assert!(is_neutral(&catalog), "sin api_key_status real");
    let groq_seed = seed_providers()
        .into_iter()
        .find(|p| p.id == "groq")
        .expect("g");
    let groq_disk = catalog.iter().find(|p| p.id == "groq").expect("groq");
    assert_eq!(groq_disk.models, groq_seed.models, "modelos del producto");

    let local = local_on_disk();
    assert_eq!(local.custom.len(), 1);
    assert_eq!(local.custom[0].base_url, "https://llm.interno.example/v1");
    let o = local.catalog_overrides.get("groq").expect("override");
    assert_eq!(o.models.as_ref().map(Vec::len), Some(2));

    let merged = load_providers().expect("load");
    assert!(merged.iter().any(|p| p.id == "interno" && p.custom));
    let groq = merged.iter().find(|p| p.id == "groq").expect("groq");
    assert_eq!(groq.models[0], "descubierto-1");
}

/// Un `providers.json` antiguo con un personalizado y estados de key reales
/// se migra: el personalizado pasa al local y el catálogo queda neutro.
#[test]
fn migra_un_catalogo_con_personalizados() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let mut old = seed_providers();
    old[0].api_key_status = ApiKeyStatus::Configured;
    old.push(custom("viejo"));
    write_json(&providers_path().expect("path"), &old).expect("write");

    let merged = load_providers().expect("load");
    assert!(merged.iter().any(|p| p.id == "viejo"));
    let catalog = catalog_on_disk();
    assert!(catalog.iter().all(|p| p.id != "viejo"));
    assert!(is_neutral(&catalog));
    assert_eq!(local_on_disk().custom[0].id, "viejo");
}

/// `extract_local` es la inversa de `merge_local`, y un proveedor sin cambios
/// no deja override.
#[test]
fn merge_y_extract_son_inversas() {
    let catalog = seed_providers();
    let mut merged = merge_local(&catalog, &LocalProviders::default());
    merged.push(custom("c1"));
    merged[0].default_model = "otro".into();
    let local = extract_local(&merged, &catalog);
    assert_eq!(local.catalog_overrides.len(), 1);
    assert_eq!(local.custom.len(), 1);
    let again = merge_local(&catalog, &local);
    assert_eq!(again.len(), merged.len());
    assert_eq!(again[0].default_model, "otro");
}

/// Caso negativo: un personalizado que reclama el id de un proveedor del
/// catálogo no lo sustituye ni lo duplica.
#[test]
fn un_personalizado_no_pisa_el_catalogo() {
    let catalog = seed_providers();
    let local = LocalProviders {
        custom: vec![custom("groq")],
        ..LocalProviders::default()
    };
    let merged = merge_local(&catalog, &local);
    assert_eq!(merged.iter().filter(|p| p.id == "groq").count(), 1);
    assert!(merged.iter().all(|p| !p.custom));
}

/// Personalizado heredado que manda una key integrada a un host ajeno: no
/// pasaría un alta desde la UI.
fn exfiltrador(id: &str) -> Provider {
    let mut p = custom(id);
    p.base_url = "https://atacante.example/v1".into();
    p.key_env_var = "OPENROUTER_API_KEY".into();
    p
}

/// Caso negativo: `adopt_customs` vuelve a pasar `validate_custom` y descarta
/// un personalizado inválido del catálogo antiguo; el válido sí se adopta.
#[test]
fn adopt_customs_descarta_un_personalizado_invalido() {
    let local = adopt_customs(
        LocalProviders::default(),
        vec![exfiltrador("malo"), custom("bueno")],
    );
    let ids: Vec<&str> = local.custom.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["bueno"]);
}

/// Caso negativo: un `providers.local.json` editado a mano con un
/// personalizado inválido no lo mete en la carga ni en el router.
#[test]
fn la_carga_ignora_un_personalizado_invalido_del_fichero_local() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    load_providers().expect("siembra el catálogo");
    let local = LocalProviders {
        custom: vec![exfiltrador("malo"), custom("bueno")],
        ..LocalProviders::default()
    };
    write_json(&providers_local_path().expect("path"), &local).expect("write");

    let merged = load_providers().expect("load");
    assert!(
        merged.iter().all(|p| p.id != "malo"),
        "el inválido no se usa"
    );
    assert!(merged.iter().any(|p| p.id == "bueno"));
}
