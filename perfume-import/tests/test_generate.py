import json

from pipeline.config import load_group
from pipeline.generate import english_master, generate_all, localize, text_fields
from tests.fake_ai import FakeClient, message

EN = (
    "Paco Rabanne Lady Million Empire is a radiant amber floral fragrance that opens with bright Sicilian lemon "
    "and juicy pear, blooms into a heart of rose and orange blossom, and settles on a warm, creamy base of "
    "vanilla and sandalwood. It is made for confident evenings, celebrations and anyone who enjoys a luminous, "
    "sensual signature scent that lasts."
)
EL = (
    "Το Paco Rabanne Lady Million Empire είναι ένα λαμπερό κεχριμπαρένιο λουλουδάτο άρωμα που ανοίγει με "
    "φωτεινό λεμόνι Σικελίας και ζουμερό αχλάδι, ανθίζει σε μια καρδιά από τριαντάφυλλο και άνθη πορτοκαλιάς "
    "και καταλήγει σε μια ζεστή, κρεμώδη βάση από βανίλια και σανταλόξυλο. Ιδανικό για βραδινές εξόδους και "
    "γιορτές, για όσους αγαπούν ένα φωτεινό, αισθησιακό άρωμα."
)
SEO = "Paco Rabanne Lady Million Empire: amber floral with lemon, rose and vanilla."
FACTS = {
    "brand": "Paco Rabanne",
    "name": "Lady Million Empire",
    "top_note": ["lemon"],
    "middle_note": ["rose"],
    "base_note": ["vanilla", "akigalawood"],
}
GROUP = load_group("group-1")


def text(description, seo=SEO, notes=(), sentence=""):
    return message(
        {"description": description, "seo_description": seo, "notes": list(notes), "tester_sentence": sentence}
    )


def master_message(description=EN):
    return message({"description": description, "seo_description": SEO})


def test_master_retries_wrong_language_then_blocks():
    client = FakeClient(master_message(EL), master_message(EL), master_message(EL))
    m = english_master(client, FACTS, GROUP)
    assert len(client.calls) == 3
    assert m.problems == [("blocked", "language_body", "След 3 опита текстът не е на „en“.")]


def test_master_length_gets_one_retry_then_warning():
    client = FakeClient(
        master_message("Short text in English about a perfume that is lovely."),
        master_message("Still a short English text about a perfume."),
    )
    m = english_master(client, FACTS, GROUP)
    assert len(client.calls) == 2
    assert m.problems[0][:2] == ("warning", "description_length")
    ok = english_master(FakeClient(master_message()), FACTS, GROUP)
    assert ok.problems == [] and "akigalawood" in ok.notes["base_note"]


def test_master_prompt_carries_guide_and_facts():
    client = FakeClient(master_message())
    english_master(client, FACTS, GROUP)
    assert "300-600 characters" in client.calls[0]["system"]
    assert "Open with the full product name" in client.calls[0]["system"]
    assert "- brand: Paco Rabanne" in client.calls[0]["messages"][0]["content"]
    assert client.calls[0]["output_config"]["effort"] == "medium" and client.calls[0]["tools"] == []


def test_localize_uses_glossary_first_and_marks_new_terms(monkeypatch):
    monkeypatch.setattr(
        "pipeline.generate.load_glossary",
        lambda lang: {"lemon": "λεμόνι", "rose": "τριαντάφυλλο", "vanilla": "βανίλια"},
    )
    master = english_master(FakeClient(master_message()), FACTS, GROUP)
    client = FakeClient(text(EL, notes=[{"en": "akigalawood", "local": "ακιγκαλάγουντ"}]))
    t = localize(client, master, "el", GROUP, tester=True)
    assert "Notes to translate: akigalawood" in client.calls[0]["messages"][0]["content"]
    assert t.notes["base_note"] == ["βανίλια", "ακιγκαλάγουντ"]
    assert t.tester_sentence == GROUP.spec.tester_sentence["el"] and not t.tester_sentence_is_new
    f = text_fields(t, master, GROUP)
    assert f["body_html"].value.endswith(GROUP.spec.tester_sentence["el"] + "</p>")
    assert f["body_html"].value_en.startswith("<p>" + EN) and "TESTER version" in f["body_html"].value_en
    assert (f["top_note"].origin, f["top_note"].status) == ("vocab", "ok")
    assert (f["base_note"].status, f["base_note"].value_en) == ("suggested", "vanilla, akigalawood")
    assert f["body_html"].status == "suggested"  # auto_accept_generated: false


def test_language_without_tester_sentence_gets_a_suggested_translation(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    master = english_master(FakeClient(master_message()), {"brand": "X"}, GROUP)
    cs = (
        "Paco Rabanne Lady Million Empire je zářivá ambrová květinová vůně, která se otevírá jasným sicilským "
        "citronem a šťavnatou hruškou, rozkvétá v srdci růže a pomerančového květu a usazuje se na teplé, krémové "
        "základně z vanilky a santalového dřeva. Je stvořena pro sebevědomé večery, oslavy a každého, "
        "kdo miluje zářivou vůni."
    )
    t = localize(
        FakeClient(text(cs, sentence="Verze TESTER obsahuje stejné složení vůně.")), master, "cs", GROUP, tester=True
    )
    assert t.tester_sentence_is_new
    f = text_fields(t, master, GROUP)
    assert "tester_sentence_new" in [i["rule"] for i in f["body_html"].issues]


HR = (
    "Paco Rabanne Lady Million Empire je blistav ambra cvjetni miris koji se otvara svijetlim sicilijanskim "
    "limunom i sočnom kruškom, cvjeta u srcu ruže i cvijeta naranče te se smiruje na toploj, kremastoj bazi "
    "vanilije i sandalovine. Stvoren je za samouvjerene večeri, proslave i svakoga tko voli blistav, senzualan "
    "potpisni miris koji dugo traje."
)


def test_generate_all_calls_each_language_once(monkeypatch):
    terms = ["lemon", "rose", "vanilla", "akigalawood"]
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {t: f"{t}-{lang}" for t in terms})

    def respond(kwargs):
        system = kwargs["system"]
        if "into Greek" in system:
            return text(EL)
        if "into Croatian" in system:
            return text(HR)
        return master_message()

    client = FakeClient(responder=respond)
    master, texts = generate_all(client, FACTS, GROUP, ["el", "hr", "el", "en"], tester=False)
    assert set(texts) == {"el", "hr", "en"}
    assert len(client.calls) == 3  # master + el + hr; en reuses the master, el is not repeated
    assert texts["en"].description == EN
    assert all(t.problems == [] for t in texts.values())


def test_wrong_language_translation_is_blocked_after_retries():
    master = english_master(FakeClient(master_message()), FACTS, GROUP)
    client = FakeClient(text(EN), text(EN), text(EN))
    t = localize(client, master, "el", GROUP, tester=False)
    assert ("blocked", "language_body") == t.problems[0][:2]
    assert json.loads(json.dumps(t.notes))  # serialisable
