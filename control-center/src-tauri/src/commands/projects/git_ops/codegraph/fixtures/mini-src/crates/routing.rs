pub fn route(zone: &str) -> usize {
    pick(zone) + 1
}

fn pick(zone: &str) -> usize {
    zone.len()
}

pub struct Router {
    pub zones: Vec<String>,
}

impl Router {
    pub fn first(&self) -> usize {
        route(&self.zones[0])
    }
}
