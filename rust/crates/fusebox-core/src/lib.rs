//! Fusebox enforcement core — versioned execution contracts and receipt journal.
//!
//! This crate defines the typed contracts shared between the CLI binary,
//! the TypeScript adapter and the fixture corpus. Field names and schema
//! versions are the stable integration surface; internal Rust representations
//! may evolve as long as serialization stays compatible.

pub mod contracts;
pub mod framing;
pub mod init;
pub mod landlock;
pub mod policy;
pub mod proxy;
pub mod receipt;
pub mod resolver;
pub mod run;
pub mod verify;
