import pytest
pytest_plugins = ["pytest_homeassistant_custom_component"]
@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield

import pathlib, custom_components
custom_components.__path__.insert(0, str(pathlib.Path(__file__).parent.parent / "custom_components"))
