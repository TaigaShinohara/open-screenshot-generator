use glib::prelude::*;

#[test]
fn strings_iterate_in_both_directions() {
    let value = vec!["first", "", "日本語", "last"].to_variant();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("日本語"));
    assert_eq!(iter.next(), None);
}

#[test]
fn nth_and_nth_back_return_the_correct_strings() {
    let value = vec!["zero", "one", "two", "three", "four"].to_variant();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.nth(1), Some("one"));
    assert_eq!(iter.nth_back(1), Some("three"));
    assert_eq!(iter.next(), Some("two"));
}

#[test]
fn collecting_and_last_preserve_borrowed_strings() {
    let value = vec!["a", "b", "c"].to_variant();
    assert_eq!(value.array_iter_str().unwrap().collect::<Vec<_>>(), vec!["a", "b", "c"]);
    assert_eq!(value.array_iter_str().unwrap().last(), Some("c"));
}

#[test]
fn empty_arrays_have_no_strings() {
    let value = Vec::<String>::new().to_variant();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}
